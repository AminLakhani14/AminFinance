/**
 * Binance — public market data and signed account endpoints.
 *
 * The signed half is the primary reason this server exists: `/api/v3/account`
 * requires an `X-MBX-APIKEY` header, which triggers a CORS preflight Binance
 * does not answer, so no browser can reach it. From Node there is no CORS.
 *
 * The API secret never leaves this process — requests are signed here and only
 * the resulting data is returned to the client.
 */
import { createHmac } from 'node:crypto';
import type {
  Quote,
  Candle,
  CandleSeries,
  CandleInterval,
  BinanceAccount,
  BinanceBalance,
  BinanceTrade,
  MarketRow,
} from '@aminfinance/shared';
import { httpGetJson, httpGet, type FetchOptions } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';
import { config } from '../config.js';

const PROVIDER = 'Binance';

/**
 * Two hosts, split by what each will serve.
 *
 * Public market data — prices, candles, the market list — goes to
 * data-api.binance.vision, Binance's market-data-only host. api.binance.com
 * refuses many hosted servers outright: Render's shared outbound addresses get
 * HTTP 418, an IP ban earned by other tenants, while the data host serves the
 * same responses to them. If the data host is itself unreachable, the main
 * host is tried before giving up.
 *
 * Signed account calls exist only on api.binance.com, so they stay there.
 */
const API_BASE = 'https://api.binance.com';
const DATA_BASE = 'https://data-api.binance.vision';

/** A host that will not serve us at all, rather than a bad request it answered. */
const HOST_REFUSED = /HTTP (403|418|451|5\d\d)\b|Network error/;

async function publicGetJson<T>(path: string, options: FetchOptions): Promise<T> {
  try {
    return await httpGetJson<T>(`${DATA_BASE}${path}`, options);
  } catch (err) {
    const refused =
      err instanceof AppError &&
      (err.code === 'upstream_timeout' || (err.code === 'provider_error' && HOST_REFUSED.test(err.message)));
    if (!refused) throw err;
    return httpGetJson<T>(`${API_BASE}${path}`, options);
  }
}

async function gate(bucket: 'binance' | 'binanceSigned'): Promise<void> {
  try {
    await acquire(bucket);
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds(bucket));
  }
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Clock skew
//
// Signed requests carry a timestamp Binance validates against its own clock.
// A drifting local clock is by far the most common cause of `-1021 Timestamp
// for this request was 1000ms ahead of the server's time`, so track the offset
// rather than let users debug a confusing error.
// ---------------------------------------------------------------------------
let clockOffsetMs = 0;
let lastSyncedAt = 0;

async function syncClock(): Promise<void> {
  if (Date.now() - lastSyncedAt < 5 * 60_000) return;
  try {
    const before = Date.now();
    const { serverTime } = await publicGetJson<{ serverTime: number }>(`/api/v3/time`, {
      provider: PROVIDER,
      timeoutMs: 5_000,
      retries: 1,
    });
    // Compensate for the round trip so the offset isn't skewed by latency.
    const rtt = Date.now() - before;
    clockOffsetMs = serverTime - (before + rtt / 2);
    lastSyncedAt = Date.now();
  } catch {
    // Keep the previous offset; a failed sync shouldn't block the request.
  }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
  prevClosePrice: string;
  volume: string;
  /** Turnover in the quote asset — comparable across pairs, unlike `volume`. */
  quoteVolume?: string;
  closeTime: number;
}

/** Quote currency inferred from the pair suffix, for display. */
function quoteCurrency(symbol: string): string {
  for (const suffix of ['USDT', 'FDUSD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR']) {
    if (symbol.endsWith(suffix)) return suffix;
  }
  return 'USDT';
}

export async function getQuote(rawSymbol: string): Promise<Quote> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate('binance');

  const t = await publicGetJson<Ticker24h>(
    `/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,
    { provider: PROVIDER },
  );

  const price = Number(t.lastPrice);
  if (!Number.isFinite(price)) {
    throw AppError.notFound(`No Binance market for "${symbol}".`);
  }

  return {
    symbol,
    assetClass: 'crypto',
    price,
    change: Number(t.priceChange),
    changePercent: Number(t.priceChangePercent),
    dayHigh: Number(t.highPrice),
    dayLow: Number(t.lowPrice),
    dayOpen: Number(t.openPrice),
    previousClose: Number(t.prevClosePrice) || null,
    volume: Number(t.volume),
    currency: quoteCurrency(symbol),
    timestamp: t.closeTime,
  };
}

/** Batch quotes — one call for many symbols beats N round trips. */
export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const normalized = symbols.map(normalizeSymbol);
  await gate('binance');

  const param = encodeURIComponent(JSON.stringify(normalized));
  const tickers = await publicGetJson<Ticker24h[]>(`/api/v3/ticker/24hr?symbols=${param}`, {
    provider: PROVIDER,
  });

  return tickers.map((t) => ({
    symbol: t.symbol,
    assetClass: 'crypto' as const,
    price: Number(t.lastPrice),
    change: Number(t.priceChange),
    changePercent: Number(t.priceChangePercent),
    dayHigh: Number(t.highPrice),
    dayLow: Number(t.lowPrice),
    dayOpen: Number(t.openPrice),
    previousClose: Number(t.prevClosePrice) || null,
    volume: Number(t.volume),
    currency: quoteCurrency(t.symbol),
    timestamp: t.closeTime,
  }));
}

const BINANCE_INTERVAL: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
};

export async function getCandles(
  rawSymbol: string,
  interval: CandleInterval,
  limit = 500,
): Promise<CandleSeries> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate('binance');

  const rows = await publicGetJson<Array<[number, string, string, string, string, string, ...unknown[]]>>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${BINANCE_INTERVAL[interval]}&limit=${Math.min(limit, 1000)}`,
    { provider: PROVIDER },
  );

  const candles: Candle[] = rows.map((r) => ({
    // Binance returns open time in ms; lightweight-charts wants seconds.
    time: Math.floor(r[0] / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));

  return { symbol, assetClass: 'crypto', interval, candles };
}

// ---------------------------------------------------------------------------
// Signed
// ---------------------------------------------------------------------------

function requireKeys(): { key: string; secret: string } {
  if (!config.providers.binanceAccount) {
    throw AppError.notConfigured('Binance account sync', 'BINANCE_API_KEY and BINANCE_API_SECRET');
  }
  return { key: config.keys.binanceKey, secret: config.keys.binanceSecret };
}

async function signedGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { key, secret } = requireKeys();
  await syncClock();
  await gate('binanceSigned');

  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now() + Math.round(clockOffsetMs)),
    recvWindow: '10000',
  });

  const signature = createHmac('sha256', secret).update(query.toString()).digest('hex');
  query.append('signature', signature);

  const res = await httpGet(`${API_BASE}${path}?${query.toString()}`, {
    provider: PROVIDER,
    headers: { 'X-MBX-APIKEY': key },
    // Never retry a signed request blindly — the timestamp would be stale and
    // a retried order-adjacent call is not something to do automatically.
    retries: 0,
  }).catch((err: unknown) => {
    throw err;
  });

  const body = (await res.json()) as T & { code?: number; msg?: string };
  if (typeof body?.code === 'number' && body.code < 0) {
    if (body.code === -1021) {
      throw AppError.providerError(
        PROVIDER,
        'Binance rejected the request timestamp (clock skew). The server re-syncs automatically — retry in a moment.',
      );
    }
    if (body.code === -2015 || body.code === -2014) {
      throw AppError.providerError(
        PROVIDER,
        'Binance rejected the API key. Check it is valid, has "Enable Reading", and that this IP is whitelisted.',
      );
    }
    throw AppError.providerError(PROVIDER, `Binance error ${body.code}: ${body.msg ?? 'unknown'}`);
  }
  return body;
}

interface RawAccount {
  balances: Array<{ asset: string; free: string; locked: string }>;
  canTrade: boolean;
  canWithdraw: boolean;
  updateTime: number;
}

export async function getAccount(): Promise<BinanceAccount> {
  const raw = await signedGet<RawAccount>('/api/v3/account');

  const balances: BinanceBalance[] = raw.balances
    .map((b) => {
      const free = Number(b.free);
      const locked = Number(b.locked);
      return { asset: b.asset, free, locked, total: free + locked };
    })
    // Binance returns every listed asset; only non-zero holdings are useful.
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total);

  return {
    balances,
    canTrade: raw.canTrade,
    canWithdraw: raw.canWithdraw,
    updateTime: raw.updateTime,
  };
}

interface RawTrade {
  id: number;
  orderId: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isBuyer: boolean;
  time: number;
}

/**
 * Trade history for one pair. Binance requires a symbol — there is no
 * account-wide trades endpoint — so the caller iterates the pairs it cares about.
 */
export async function getTrades(rawSymbol: string, limit = 500): Promise<BinanceTrade[]> {
  const symbol = normalizeSymbol(rawSymbol);
  const raw = await signedGet<RawTrade[]>('/api/v3/myTrades', {
    symbol,
    limit: Math.min(limit, 1000),
  });

  if (!Array.isArray(raw)) return [];

  return raw.map((t) => ({
    id: String(t.id),
    orderId: String(t.orderId),
    symbol: t.symbol,
    price: Number(t.price),
    quantity: Number(t.qty),
    quoteQuantity: Number(t.quoteQty),
    commission: Number(t.commission),
    commissionAsset: t.commissionAsset,
    isBuyer: t.isBuyer,
    time: t.time,
  }));
}

/** Which pairs actually trade — used to map a held asset to a priceable pair. */
let exchangeSymbols: Set<string> | null = null;

export async function getTradablePairs(): Promise<Set<string>> {
  if (exchangeSymbols) return exchangeSymbols;
  await gate('binance');
  const info = await publicGetJson<{ symbols: Array<{ symbol: string; status: string }> }>(
    `/api/v3/exchangeInfo?permissions=SPOT`,
    { provider: PROVIDER, timeoutMs: 20_000 },
  );
  exchangeSymbols = new Set(
    info.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol),
  );
  return exchangeSymbols;
}

/**
 * Wrapped and staked variants that are economically the same asset.
 *
 * Binance reports Earn/staking positions under their own ticker — WBETH and
 * BETH are both just ETH accruing yield, and holding them alongside a plain
 * ETH balance would otherwise surface as two unrelated positions. Merging
 * them also means the position prices off the deep ETHUSDT book rather than
 * a thin wrapper pair.
 *
 * Note this is a *display and accounting* merge, not a claim that the prices
 * are identical: WBETH trades at a small premium to ETH as staking rewards
 * accrue. That premium is well under the noise floor of a portfolio tracker.
 */
const ASSET_ALIASES: Record<string, string> = {
  WBETH: 'ETH',
  BETH: 'ETH',
  WBTC: 'BTC',
  LDBTC: 'BTC',
};

/** Collapse a wrapped/staked ticker to the asset it represents. */
export function canonicalAsset(asset: string): string {
  const a = asset.toUpperCase();
  return ASSET_ALIASES[a] ?? a;
}

/**
 * Best priceable pair for a held asset, e.g. BTC -> BTCUSDT.
 *
 * Stablecoins map to themselves at 1.0 (handled by the caller); assets with no
 * USDT pair fall back to BTC and are converted in two hops.
 */
export async function resolvePair(asset: string): Promise<string | null> {
  const a = canonicalAsset(asset);
  if (a === 'USDT') return null;
  const pairs = await getTradablePairs();
  for (const quote of ['USDT', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB']) {
    const candidate = `${a}${quote}`;
    if (pairs.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Every tradable pair's 24h ticker in a single call.
 *
 * `/ticker/24hr` with no `symbol` parameter returns the whole book — around
 * 3,000 rows. That is one request instead of thousands, but it is also a heavy
 * one (weight 80), so the caller is expected to cache it rather than poll.
 *
 * Filtered to a single quote asset by default: the raw list contains every
 * cross (BTCETH, ETHBNB, …), which is noise for someone browsing what to buy,
 * and the same coin appears a dozen times priced in different assets.
 */
export async function getMarketTickers(quoteAsset = 'USDT'): Promise<MarketRow[]> {
  await gate('binance');

  const tickers = await publicGetJson<Ticker24h[]>(`/api/v3/ticker/24hr`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });

  const suffix = quoteAsset.toUpperCase();
  const rows: MarketRow[] = [];

  for (const t of tickers) {
    const symbol = t.symbol?.toUpperCase();
    if (!symbol || !symbol.endsWith(suffix) || symbol.length <= suffix.length) continue;

    const price = Number(t.lastPrice);
    // Delisted and pre-launch pairs sit in the list at zero; they are not
    // buyable and would dominate any sort by percentage change.
    if (!Number.isFinite(price) || price <= 0) continue;

    rows.push({
      symbol,
      assetClass: 'crypto',
      price,
      change: Number(t.priceChange) || 0,
      changePercent: Number(t.priceChangePercent) || 0,
      volume: Number(t.quoteVolume) || null,
      currency: suffix,
    });
  }

  return rows;
}
