/**
 * TradingView — PSX prices, daily candles, the market listing and a dividend
 * snapshot.
 *
 * Why this exists: the PSX Data Portal's JSON endpoints (`/timeseries/*`,
 * `/market-watch`, `/symbols`, `/company/payouts`) began returning 404/403 in
 * September 2026 — for the exchange's own website too, so it is a removal, not
 * a block on us. The company pages still render, so issuer fundamentals stay
 * on PSX; everything priced moves here.
 *
 * ⚠️ Neither endpoint below is a documented public API. They are what
 * tradingview.com's own pages use, unauthenticated:
 *
 *   - The scanner (`scanner.tradingview.com/pakistan/scan`) answers a whole
 *     market, or any list of tickers, in one POST — one request for every PSX
 *     price in the book, where the Data Portal needed two per symbol.
 *   - Candles come over the chart websocket. One connection carries a chart
 *     session per symbol, so a batch of thirty histories costs one handshake
 *     and arrives in about a second.
 *
 * Prices are delayed (the scanner reports `delayed_streaming_900`, fifteen
 * minutes), and each quote's timestamp is backdated by that delay so the UI's
 * freshness labels stay honest.
 */
import WebSocket from 'ws';
import type { AssetClass, Candle, CandleInterval, MarketRow, Quote } from '@aminfinance/shared';
import { httpGet } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';

const PROVIDER = 'TradingView';
const SOCKET_URL = 'wss://data.tradingview.com/socket.io/websocket?type=chart';

/**
 * Where a symbol trades, in TradingView's naming.
 *
 * PSX is this provider's main job. Binance is the fallback for crypto when
 * Binance itself refuses the server's address — hosted servers on shared IPs
 * get HTTP 418 from every Binance host, while TradingView serves Binance's own
 * pairs (`BINANCE:BTCUSDT`) from the same feed, in real time.
 */
export type Venue = 'PSX' | 'BINANCE';

const VENUES: Record<Venue, { scanUrl: string; assetClass: AssetClass; currency: string }> = {
  PSX: { scanUrl: 'https://scanner.tradingview.com/pakistan/scan', assetClass: 'stock', currency: 'PKR' },
  BINANCE: { scanUrl: 'https://scanner.tradingview.com/crypto/scan', assetClass: 'crypto', currency: 'USDT' },
};

/** Chart sessions per connection. Comfortably under what the site itself opens. */
const SESSIONS_PER_SOCKET = 40;
/** A batch that has not completed by now is returned with the stragglers failed. */
const SOCKET_TIMEOUT_MS = 15_000;

async function gate(): Promise<void> {
  try {
    await acquire('tradingview', 10_000);
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('tradingview'));
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface ScanRow {
  /** "PSX:FFC" */
  s: string;
  /** Values in the order of the requested columns. */
  d: unknown[];
}

/** One scanner POST. Rows that do not have the expected shape are dropped. */
async function scan(body: Record<string, unknown>, venue: Venue = 'PSX'): Promise<ScanRow[]> {
  await gate();
  const res = await httpGet(VENUES[venue].scanUrl, {
    provider: PROVIDER,
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    timeoutMs: 12_000,
  });

  let json: { data?: unknown };
  try {
    json = (await res.json()) as { data?: unknown };
  } catch (err) {
    throw AppError.providerError(PROVIDER, `${PROVIDER} scanner returned malformed JSON.`, err);
  }
  if (!Array.isArray(json.data)) {
    throw AppError.providerError(PROVIDER, `${PROVIDER} scanner response has no data array.`);
  }
  return json.data.filter(
    (row): row is ScanRow =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as ScanRow).s === 'string' &&
      Array.isArray((row as ScanRow).d),
  );
}

/** Reads a scanner row by column name, so the column list is the only order to keep. */
function reader<const C extends readonly string[]>(columns: C) {
  return (row: ScanRow, column: C[number]): unknown => row.d[columns.indexOf(column)];
}

function tickerOf(row: ScanRow): string {
  return (row.s.split(':')[1] ?? row.s).toUpperCase();
}

/** "delayed_streaming_900" → 900. Anything else is treated as real time. */
function delaySeconds(updateMode: unknown): number {
  const match = typeof updateMode === 'string' ? /delayed_streaming_(\d+)/.exec(updateMode) : null;
  return match ? Number(match[1]) : 0;
}

const QUOTE_COLUMNS = [
  'close',
  'change',
  'change_abs',
  'open',
  'high',
  'low',
  'volume',
  'update_mode',
  'currency',
] as const;
const quoteCol = reader(QUOTE_COLUMNS);

function toQuote(row: ScanRow, venue: Venue): Quote | null {
  const price = num(quoteCol(row, 'close'));
  if (price === null || price <= 0) return null;
  const change = num(quoteCol(row, 'change_abs')) ?? 0;
  return {
    symbol: tickerOf(row),
    assetClass: VENUES[venue].assetClass,
    price,
    change,
    changePercent: num(quoteCol(row, 'change')) ?? 0,
    dayHigh: num(quoteCol(row, 'high')),
    dayLow: num(quoteCol(row, 'low')),
    dayOpen: num(quoteCol(row, 'open')),
    previousClose: price - change,
    volume: num(quoteCol(row, 'volume')),
    currency: str(quoteCol(row, 'currency')) ?? VENUES[venue].currency,
    timestamp: Date.now() - delaySeconds(quoteCol(row, 'update_mode')) * 1000,
  };
}

/**
 * Quotes for many symbols on one venue in one request.
 *
 * Symbols the scanner does not know come back in `missing` rather than
 * failing the batch — one delisted ticker must not blank the whole book.
 */
export async function getQuotes(
  symbols: string[],
  venue: Venue = 'PSX',
): Promise<{ quotes: Quote[]; missing: string[] }> {
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { quotes: [], missing: [] };

  const rows = await scan(
    { symbols: { tickers: wanted.map((s) => `${venue}:${s}`) }, columns: QUOTE_COLUMNS },
    venue,
  );
  const quotes = rows.map((row) => toQuote(row, venue)).filter((q): q is Quote => q !== null);
  const found = new Set(quotes.map((q) => q.symbol));
  return { quotes, missing: wanted.filter((s) => !found.has(s)) };
}

export async function getQuote(symbol: string, venue: Venue = 'PSX'): Promise<Quote> {
  const { quotes } = await getQuotes([symbol], venue);
  const quote = quotes[0];
  if (!quote) {
    throw AppError.notFound(`No ${venue === 'PSX' ? 'PSX' : 'Binance'} quote for "${symbol.toUpperCase()}". Check the ticker.`);
  }
  return quote;
}

const LISTING_COLUMNS = ['close', 'change', 'change_abs', 'volume', 'description', 'sector'] as const;
const listingCol = reader(LISTING_COLUMNS);

/**
 * Every PSX equity, fund and receipt in one request, most-traded first.
 *
 * Replaces the Data Portal's scraped market-watch page, and is better for it:
 * names and sectors arrive with the prices instead of from a second directory
 * request, and there is no HTML to drift.
 */
export async function getMarketListing(): Promise<MarketRow[]> {
  const rows = await scan({
    filter: [
      { left: 'exchange', operation: 'equal', right: 'PSX' },
      { left: 'type', operation: 'in_range', right: ['stock', 'dr', 'fund'] },
    ],
    columns: LISTING_COLUMNS,
    sort: { sortBy: 'volume', sortOrder: 'desc' },
    range: [0, 1500],
  });

  const listing: MarketRow[] = [];
  for (const row of rows) {
    const price = num(listingCol(row, 'close'));
    if (price === null || price <= 0) continue;
    listing.push({
      symbol: tickerOf(row),
      assetClass: 'stock',
      price,
      change: num(listingCol(row, 'change_abs')) ?? 0,
      changePercent: num(listingCol(row, 'change')) ?? 0,
      volume: num(listingCol(row, 'volume')),
      currency: VENUES.PSX.currency,
      name: str(listingCol(row, 'description')),
      sector: str(listingCol(row, 'sector')),
      // Index membership was a market-watch column; the scanner has no equivalent.
      listedIn: null,
    });
  }

  if (listing.length === 0) {
    throw AppError.providerError(PROVIDER, 'The PSX listing came back empty.');
  }
  return listing;
}

const CRYPTO_LISTING_COLUMNS = ['name', 'close', 'change', 'change_abs', 'volume'] as const;
const cryptoCol = reader(CRYPTO_LISTING_COLUMNS);

/**
 * Binance spot pairs quoted in `quoteAsset`, most-traded first — the same
 * rows `binance.getMarketTickers` returns, for when Binance refuses us.
 *
 * `volume` is reported as the quote-currency amount traded, as Binance's
 * `quoteVolume` is: the scanner gives base volume, so it is multiplied by
 * price here. (Its own traded-value column comes back empty for crypto.)
 */
export async function getCryptoListing(quoteAsset = 'USDT'): Promise<MarketRow[]> {
  const quote = quoteAsset.toUpperCase();
  const rows = await scan(
    {
      filter: [
        { left: 'exchange', operation: 'equal', right: 'BINANCE' },
        { left: 'currency', operation: 'equal', right: quote },
        { left: 'type', operation: 'equal', right: 'spot' },
      ],
      columns: CRYPTO_LISTING_COLUMNS,
      range: [0, 2000],
    },
    'BINANCE',
  );

  const listing: MarketRow[] = [];
  for (const row of rows) {
    const price = num(cryptoCol(row, 'close'));
    if (price === null || price <= 0) continue;
    const baseVolume = num(cryptoCol(row, 'volume'));
    listing.push({
      symbol: str(cryptoCol(row, 'name'))?.toUpperCase() ?? tickerOf(row),
      assetClass: 'crypto',
      price,
      change: num(cryptoCol(row, 'change_abs')) ?? 0,
      changePercent: num(cryptoCol(row, 'change')) ?? 0,
      volume: baseVolume !== null ? baseVolume * price : null,
      currency: quote,
    });
  }

  if (listing.length === 0) {
    throw AppError.providerError(PROVIDER, `The Binance ${quote} listing came back empty.`);
  }
  return listing.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

/** Every Binance spot pair, for mapping a held coin to a priceable pair. */
export async function getCryptoPairs(): Promise<Set<string>> {
  const rows = await scan(
    {
      filter: [
        { left: 'exchange', operation: 'equal', right: 'BINANCE' },
        { left: 'type', operation: 'equal', right: 'spot' },
      ],
      columns: ['name'],
      range: [0, 5000],
    },
    'BINANCE',
  );
  return new Set(rows.map((row) => (typeof row.d[0] === 'string' ? row.d[0].toUpperCase() : tickerOf(row))));
}

const DIVIDEND_COLUMNS = [
  'dps_common_stock_prim_issue_fy',
  'dividend_ex_date_recent',
  'dividend_amount_recent',
  'dividend_ex_date_upcoming',
  'dividend_amount_upcoming',
] as const;
const dividendCol = reader(DIVIDEND_COLUMNS);

export interface DividendSnapshot {
  /** Dividends per share declared for the last fiscal year. */
  fiscalYearAmount: number | null;
  recent: { exDate: string; amount: number } | null;
  upcoming: { exDate: string; amount: number } | null;
}

function isoDate(epochSeconds: number | null): string | null {
  return epochSeconds === null ? null : new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The scanner's dividend fields: last fiscal year's total, the most recent
 * payout and the next announced one. Thinner than the Data Portal's payout
 * table was — no full history — but already per share in rupees, so there is
 * no percent-of-par conversion to get wrong.
 */
export async function getDividendSnapshot(symbol: string): Promise<DividendSnapshot> {
  const rows = await scan({
    symbols: { tickers: [`PSX:${symbol.toUpperCase()}`] },
    columns: DIVIDEND_COLUMNS,
  });
  const row = rows[0];
  if (!row) return { fiscalYearAmount: null, recent: null, upcoming: null };

  const event = (dateCol: (typeof DIVIDEND_COLUMNS)[number], amountCol: (typeof DIVIDEND_COLUMNS)[number]) => {
    const exDate = isoDate(num(dividendCol(row, dateCol)));
    const amount = num(dividendCol(row, amountCol));
    return exDate && amount !== null && amount > 0 ? { exDate, amount } : null;
  };

  const fy = num(dividendCol(row, 'dps_common_stock_prim_issue_fy'));
  return {
    fiscalYearAmount: fy !== null && fy > 0 ? fy : null,
    recent: event('dividend_ex_date_recent', 'dividend_amount_recent'),
    upcoming: event('dividend_ex_date_upcoming', 'dividend_amount_upcoming'),
  };
}

const PROFILE_COLUMNS = [
  'description',
  'sector',
  'market_cap_basic',
  'price_earnings_ttm',
  'earnings_per_share_basic_ttm',
  'dividends_yield_current',
  'dps_common_stock_prim_issue_fy',
] as const;
const profileCol = reader(PROFILE_COLUMNS);

/** The issuer facts a trade plan weighs. Every field may be missing. */
export interface IssuerProfile {
  name: string | null;
  sector: string | null;
  marketCap: number | null;
  peRatio: number | null;
  epsTtm: number | null;
  /** Percent, against today's price. */
  dividendYield: number | null;
  /** Dividends per share declared for the last fiscal year. */
  fiscalYearDividend: number | null;
}

/**
 * Issuer facts for many symbols in one request.
 *
 * The company-page scrape in `psx.ts` gives the same figures one page per
 * issuer at about a second each; a screen of several names needs them all at
 * once, which this does in a single call.
 */
export async function getProfiles(symbols: string[]): Promise<Record<string, IssuerProfile>> {
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return {};

  const rows = await scan({
    symbols: { tickers: wanted.map((s) => `PSX:${s}`) },
    columns: PROFILE_COLUMNS,
  });

  const out: Record<string, IssuerProfile> = {};
  for (const row of rows) {
    const fy = num(profileCol(row, 'dps_common_stock_prim_issue_fy'));
    out[tickerOf(row)] = {
      name: str(profileCol(row, 'description')),
      sector: str(profileCol(row, 'sector')),
      marketCap: num(profileCol(row, 'market_cap_basic')),
      peRatio: num(profileCol(row, 'price_earnings_ttm')),
      epsTtm: num(profileCol(row, 'earnings_per_share_basic_ttm')),
      dividendYield: num(profileCol(row, 'dividends_yield_current')),
      fiscalYearDividend: fy !== null && fy > 0 ? fy : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candles over the chart websocket
// ---------------------------------------------------------------------------

const RESOLUTION: Record<CandleInterval, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
};

/** Socket.io-style framing: `~m~<length>~m~<payload>`. */
function frame(payload: string): string {
  return `~m~${payload.length}~m~${payload}`;
}

function message(method: string, params: unknown[]): string {
  return frame(JSON.stringify({ m: method, p: params }));
}

/** `[time, open, high, low, close, volume?]` → Candle, or null if malformed. */
function toCandle(values: unknown): Candle | null {
  if (!Array.isArray(values)) return null;
  const [time, open, high, low, close, volume] = values.map(num);
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return { time, open, high, low, close, volume: volume ?? 0 };
}

/**
 * Histories for up to `SESSIONS_PER_SOCKET` symbols over one connection.
 *
 * Each symbol gets its own chart session, and every server message names its
 * session, so responses are demultiplexed by that. The connection resolves as
 * soon as every session has completed or errored; anything still pending at
 * the timeout fails individually rather than failing the batch.
 */
async function candlesOverSocket(
  symbols: string[],
  interval: CandleInterval,
  limit: number,
  venue: Venue,
): Promise<Map<string, Candle[] | Error>> {
  await gate();
  const market = venue === 'PSX' ? 'PSX' : 'Binance';

  return new Promise((resolve) => {
    const sessions = new Map<string, { symbol: string; bars: Candle[]; done: boolean; error?: Error }>();
    const ws = new WebSocket(SOCKET_URL, {
      headers: { Origin: 'https://www.tradingview.com' },
      handshakeTimeout: 8_000,
    });

    let settled = false;
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();

      const out = new Map<string, Candle[] | Error>();
      for (const s of sessions.values()) {
        if (s.error) out.set(s.symbol, s.error);
        else if (s.done && s.bars.length > 0) out.set(s.symbol, s.bars.slice(-limit));
        else if (s.done) out.set(s.symbol, AppError.notFound(`No ${market} history for "${s.symbol}".`));
        else {
          out.set(
            s.symbol,
            failure ?? AppError.providerError(PROVIDER, `${PROVIDER} did not return ${s.symbol}'s history in time.`),
          );
        }
      }
      resolve(out);
    };
    const timer = setTimeout(() => finish(), SOCKET_TIMEOUT_MS);

    symbols.forEach((symbol, i) => {
      sessions.set(`cs_${i}_${Math.random().toString(36).slice(2, 10)}`, { symbol, bars: [], done: false });
    });

    ws.on('open', () => {
      ws.send(message('set_auth_token', ['unauthorized_user_token']));
      for (const [cs, s] of sessions) {
        ws.send(message('chart_create_session', [cs, '']));
        ws.send(
          message('resolve_symbol', [
            cs,
            'sym',
            '=' + JSON.stringify({ symbol: `${venue}:${s.symbol}`, adjustment: 'splits', session: 'regular' }),
          ]),
        );
        ws.send(message('create_series', [cs, 's1', 's1', 'sym', RESOLUTION[interval], limit, '']));
      }
    });

    ws.on('message', (data) => {
      for (const part of data.toString().split(/~m~\d+~m~/)) {
        if (!part) continue;
        // Heartbeats must be echoed or the server drops the connection.
        if (part.startsWith('~h~')) {
          ws.send(frame(part));
          continue;
        }

        let msg: { m?: string; p?: unknown[] };
        try {
          msg = JSON.parse(part) as typeof msg;
        } catch {
          continue;
        }
        const session = typeof msg.p?.[0] === 'string' ? sessions.get(msg.p[0]) : undefined;
        if (!session) continue;

        if (msg.m === 'timescale_update') {
          const series = (msg.p?.[1] as { s1?: { s?: Array<{ v?: unknown }> } } | undefined)?.s1?.s;
          if (Array.isArray(series)) {
            session.bars = series
              .map((bar) => toCandle(bar.v))
              .filter((c): c is Candle => c !== null)
              .sort((a, b) => a.time - b.time);
          }
        } else if (msg.m === 'series_completed') {
          session.done = true;
        } else if (msg.m === 'symbol_error' || msg.m === 'series_error') {
          session.done = true;
          session.error = AppError.notFound(`${market} has no symbol "${session.symbol}". Check the ticker.`);
        }

        if ([...sessions.values()].every((s) => s.done)) finish();
      }
    });

    ws.on('error', (err) =>
      finish(AppError.providerError(PROVIDER, `Could not reach ${PROVIDER}'s chart feed.`, err)),
    );
    ws.on('close', () =>
      finish(AppError.providerError(PROVIDER, `${PROVIDER}'s chart feed closed early.`)),
    );
  });
}

/**
 * Candle histories for many symbols, oldest bar first. Each entry is either
 * the candles or the error for that symbol alone.
 */
export async function getCandlesBatch(
  symbols: string[],
  interval: CandleInterval,
  limit: number,
  venue: Venue = 'PSX',
): Promise<Map<string, Candle[] | Error>> {
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const bars = Math.max(1, Math.min(limit, 2000));
  const chunks: string[][] = [];
  for (let i = 0; i < wanted.length; i += SESSIONS_PER_SOCKET) {
    chunks.push(wanted.slice(i, i + SESSIONS_PER_SOCKET));
  }

  const results = await Promise.all(chunks.map((chunk) => candlesOverSocket(chunk, interval, bars, venue)));
  return new Map(results.flatMap((m) => [...m]));
}

export async function getCandles(
  symbol: string,
  interval: CandleInterval,
  limit: number,
  venue: Venue = 'PSX',
): Promise<Candle[]> {
  const result = (await getCandlesBatch([symbol], interval, limit, venue)).get(symbol.trim().toUpperCase());
  if (!result) throw AppError.providerError(PROVIDER, `No history returned for "${symbol}".`);
  if (result instanceof Error) throw result;
  return result;
}
