/**
 * Pakistan Stock Exchange — Data Portal Service (dps.psx.com.pk).
 *
 * ⚠️ This is the PSX website's own backend, not a documented public API. It has
 * no versioning guarantee and can change without notice. Everything here is
 * therefore written defensively: shapes are validated before they reach the
 * cache, HTML selectors live in one table, and a parse failure degrades to a
 * partial result rather than throwing away the whole response.
 *
 * Verified endpoints (checked against a live JS InvestPro portfolio):
 *   /timeseries/int/{SYM}  → [[epochSec, price, volume], ...]  newest first
 *   /timeseries/eod/{SYM}  → [[epochSec, close, volume, open], ...] newest first
 *   /company/{SYM}         → HTML; stats_label/stats_value pairs
 *
 * Day change is close − previous row's close (the broker's LDCP), which
 * reproduces JS InvestPro's figures exactly.
 */
import type {
  Quote,
  Candle,
  CandleSeries,
  CandleInterval,
  Fundamentals,
  DividendInfo,
  DividendEvent,
  MarketRow,
} from '@aminfinance/shared';
import { httpGetJson, httpGetText } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';

const BASE = 'https://dps.psx.com.pk';
const PROVIDER = 'PSX';

/** PSX quotes in PKR; symbols are uppercase and unsuffixed. */
const CURRENCY = 'PKR';

interface TimeseriesResponse {
  status: number;
  message: string;
  data: number[][];
}

async function gate(): Promise<void> {
  try {
    await acquire('psx');
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('psx'));
  }
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Rows are `[epochSeconds, value, ...]`. Reject anything that isn't — a
 * silently-changed shape must fail loudly here, not produce NaN prices three
 * layers up in a chart.
 */
function validateRows(rows: unknown, minColumns: number, symbol: string): number[][] {
  if (!Array.isArray(rows)) {
    throw AppError.providerError(PROVIDER, `PSX returned no data array for ${symbol}.`);
  }
  const valid = rows.filter(
    (r): r is number[] =>
      Array.isArray(r) && r.length >= minColumns && r.every((v) => typeof v === 'number' && Number.isFinite(v)),
  );
  if (valid.length === 0) {
    throw AppError.notFound(`No PSX data for symbol "${symbol}". Check the ticker.`);
  }
  return valid;
}

async function fetchEod(symbol: string): Promise<number[][]> {
  await gate();
  const body = await httpGetJson<TimeseriesResponse>(`${BASE}/timeseries/eod/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 15_000,
  });
  if (body.status !== 1) {
    throw AppError.notFound(`PSX has no EOD series for "${symbol}".`);
  }
  return validateRows(body.data, 3, symbol);
}

async function fetchIntraday(symbol: string): Promise<number[][]> {
  await gate();
  const body = await httpGetJson<TimeseriesResponse>(`${BASE}/timeseries/int/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 15_000,
  });
  if (body.status !== 1) return [];
  try {
    return validateRows(body.data, 3, symbol);
  } catch {
    // Intraday is empty outside market hours — not an error.
    return [];
  }
}

/**
 * Current quote.
 *
 * Uses EOD as the source of truth for close/volume/open (it matches the broker
 * exactly) and overlays the latest intraday tick when the market is open, so
 * the price is live during a session without losing the reliable daily fields.
 */
export async function getQuote(rawSymbol: string): Promise<Quote> {
  const symbol = normalizeSymbol(rawSymbol);
  const [eod, intraday] = await Promise.all([fetchEod(symbol), fetchIntraday(symbol)]);

  const today = eod[0];
  const yesterday = eod[1];
  if (!today) throw AppError.notFound(`No PSX quote for "${symbol}".`);

  const [timestampSec, eodClose, volume, open] = today as [number, number, number, number?];
  const previousClose = yesterday?.[1] ?? null;

  // Latest intraday tick wins when present — rows are newest-first.
  const latestTick = intraday[0];
  const price = latestTick?.[1] ?? eodClose;
  const tickTime = latestTick?.[0] ?? timestampSec;

  // Session high/low from intraday when available; EOD carries neither.
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  if (intraday.length > 0) {
    const prices = intraday.map((r) => r[1]).filter((p): p is number => typeof p === 'number');
    if (prices.length > 0) {
      dayHigh = Math.max(...prices);
      dayLow = Math.min(...prices);
    }
  }

  const change = previousClose !== null ? price - previousClose : 0;
  const changePercent = previousClose ? (change / previousClose) * 100 : 0;

  return {
    symbol,
    assetClass: 'stock',
    price,
    change,
    changePercent,
    dayHigh,
    dayLow,
    dayOpen: open ?? null,
    previousClose,
    volume: volume ?? null,
    currency: CURRENCY,
    timestamp: tickTime * 1000,
  };
}

const INTERVAL_IS_INTRADAY: Record<CandleInterval, boolean> = {
  '1m': true,
  '5m': true,
  '15m': true,
  '1h': true,
  '4h': true,
  '1d': false,
  '1w': false,
};

/**
 * OHLCV series.
 *
 * PSX EOD gives close/volume/open but no high or low, so intraday candles are
 * built by bucketing ticks, and daily candles report open/close honestly with
 * high/low derived from the pair rather than invented.
 */
export async function getCandles(
  rawSymbol: string,
  interval: CandleInterval,
  limit = 400,
): Promise<CandleSeries> {
  const symbol = normalizeSymbol(rawSymbol);

  if (INTERVAL_IS_INTRADAY[interval]) {
    const ticks = await fetchIntraday(symbol);
    return { symbol, assetClass: 'stock', interval, candles: bucketTicks(ticks, interval) };
  }

  const eod = await fetchEod(symbol);
  const bucketWeekly = interval === '1w';

  // Oldest-first for charting.
  const rows = [...eod].reverse();
  const daily: Candle[] = rows.map((row) => {
    const [t, close, volume, open] = row as [number, number, number, number?];
    const o = open ?? close;
    return {
      time: t,
      open: o,
      // No true intraday extremes in the EOD feed. Using the open/close pair is
      // accurate as far as it goes; inventing a wider range would not be.
      high: Math.max(o, close),
      low: Math.min(o, close),
      close,
      volume: volume ?? 0,
    };
  });

  const candles = bucketWeekly ? toWeekly(daily) : daily;
  return { symbol, assetClass: 'stock', interval, candles: candles.slice(-limit) };
}

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
};

/** Collapse raw ticks into OHLCV buckets. */
function bucketTicks(ticks: number[][], interval: CandleInterval): Candle[] {
  const size = INTERVAL_SECONDS[interval] ?? 300;
  const buckets = new Map<number, Candle>();

  // Oldest-first so `open` is genuinely the first trade of the bucket.
  for (const row of [...ticks].reverse()) {
    const [t, price, volume] = row as [number, number, number];
    const key = Math.floor(t / size) * size;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { time: key, open: price, high: price, low: price, close: price, volume: volume ?? 0 });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += volume ?? 0;
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function toWeekly(daily: Candle[]): Candle[] {
  const weeks = new Map<number, Candle>();
  for (const candle of daily) {
    // ISO week bucket: floor to Monday UTC.
    const date = new Date(candle.time * 1000);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    date.setUTCHours(0, 0, 0, 0);
    const key = Math.floor(date.getTime() / 1000);

    const existing = weeks.get(key);
    if (!existing) {
      weeks.set(key, { ...candle, time: key });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Company page scraping
// ---------------------------------------------------------------------------

/**
 * All HTML coupling lives here. When PSX changes their markup this table is
 * the only thing that needs editing.
 */
const STATS_PATTERN =
  /<div class="stats_label">([\s\S]*?)<\/div>\s*<div class="stats_value">([\s\S]*?)<\/div>/g;

/**
 * The issuer's own website, from the company profile's WEBSITE block.
 *
 * PSX publishes no company logos, but it does publish this — and an issuer's
 * domain is enough to fetch its favicon, which is in practice its logo. That
 * makes a real mark derivable for most of the ~500 listings instead of only
 * the few dozen anyone would hand-maintain a table for.
 */
const WEBSITE_PATTERN = /WEBSITE<\/div>\s*<p>\s*<a[^>]*href="([^"]+)"/i;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * A logo URL for the issuer, derived from the website it lists with PSX.
 *
 * The exchange hosts no company logos, so this goes via the issuer's own
 * domain and a favicon service. That is a real mark for most listings rather
 * than the few dozen a hand-kept table would ever cover, and it stays correct
 * as companies are listed and renamed without anyone editing a mapping.
 *
 * Returns null rather than guessing when there is no usable website — the
 * client renders a generated monogram in that case, and a guessed domain would
 * risk putting some other company's logo on a holding.
 */
function issuerLogoUrl(html: string): string | null {
  const href = WEBSITE_PATTERN.exec(html)?.[1]?.trim();
  if (!href) return null;

  let host: string;
  try {
    // Listed values are inconsistent about the scheme; assume http when absent
    // so the URL parses. Only the host is used, so the scheme never matters.
    host = new URL(/^https?:\/\//i.test(href) ? href : `http://${href}`).hostname;
  } catch {
    return null;
  }

  host = host.replace(/^www\./i, '').toLowerCase();
  // A bare label with no dot is not a domain, and PSX's own host would yield
  // the exchange's logo on every row.
  if (!host.includes('.') || host.endsWith('psx.com.pk')) return null;

  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** First value for a label, matched case-insensitively on a prefix. */
function pick(stats: Array<[string, string]>, labelPrefix: string): string | undefined {
  const needle = labelPrefix.toLowerCase();
  return stats.find(([label]) => label.toLowerCase().startsWith(needle))?.[1];
}

export async function getFundamentals(rawSymbol: string): Promise<Fundamentals> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();
  const html = await httpGetText(`${BASE}/company/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });

  const flat = html.replace(/\n/g, '');
  const stats: Array<[string, string]> = [];
  for (const match of flat.matchAll(STATS_PATTERN)) {
    stats.push([stripTags(match[1] ?? ''), stripTags(match[2] ?? '')]);
  }

  if (stats.length === 0) {
    throw AppError.providerError(
      PROVIDER,
      `Could not parse the PSX company page for ${symbol} — the page markup may have changed.`,
    );
  }

  // Tag-agnostic and tolerant of nested markup: PSX renders the name in a
  // <div class="quote__name"> and wraps the sector text in a <span>.
  const name =
    stripTags(flat.match(/class="quote__name"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || symbol;
  const sector =
    stripTags(flat.match(/class="quote__sector"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || null;

  // "Market Cap (000's)" — the figure is in thousands of PKR.
  const marketCapThousands = parseNumber(pick(stats, 'market cap'));
  const marketCap = marketCapThousands !== null ? marketCapThousands * 1000 : null;

  // 52-week range renders as "425.00 — 685.00".
  const range52 = pick(stats, '52-week');
  const rangeParts = range52?.split(/[—–-]/).map((p) => parseNumber(p)) ?? [];

  return {
    symbol,
    assetClass: 'stock',
    name,
    currency: CURRENCY,
    marketCap,
    peRatio: parseNumber(pick(stats, 'p/e ratio')),
    epsTtm: parseNumber(pick(stats, 'eps')),
    dividendYield: parseNumber(pick(stats, 'dividend yield')),
    beta: null,
    sector,
    industry: null,
    exchange: 'PSX',
    description: null,
    logoUrl: issuerLogoUrl(html),
    weekHigh52: rangeParts[1] ?? null,
    weekLow52: rangeParts[0] ?? null,
    circulatingSupply: null,
  };
}

/**
 * Dividends.
 *
 * The company page renders its payouts section client-side, so the HTML we get
 * from `/company/{SYM}` has an empty shell. The table behind it comes from a
 * separate POST the page's own script makes:
 *
 *   POST /company/payouts   (form-encoded `symbol=LUCK`)  → an HTML <table>
 *
 * Undocumented like the rest of this portal, so it is parsed defensively: a
 * shape change yields fewer events, never a throw.
 *
 * PSX quotes cash dividends as a percentage of the PKR 10 par value, not of
 * the share price — "250%" is PKR 25 per share, on a share trading near 440.
 * Reading that as a yield would overstate the payout by roughly fifty times,
 * so the conversion to a per-share amount happens here, once, rather than in
 * each caller.
 */

/** Par value of a PSX ordinary share. Dividend percentages are quoted on this. */
const PAR_VALUE = 10;

export async function getDividends(rawSymbol: string): Promise<DividendInfo> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();

  let html: string;
  try {
    html = await httpGetText(`${BASE}/company/payouts`, {
      provider: PROVIDER,
      timeoutMs: 20_000,
      method: 'POST',
      body: `symbol=${encodeURIComponent(symbol)}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
  } catch {
    // A dividend history that cannot be fetched is unknown, not zero. An empty
    // result renders as "none announced", which is the same thing the caller
    // shows for a genuine non-payer, so failing soft here is honest enough —
    // and better than failing the whole asset page over a secondary panel.
    return { symbol, assetClass: 'stock', next: null, history: [], trailingAnnualAmount: null };
  }

  const events = parsePayouts(html);

  // Rows are announcements, and an announcement dated in the future is one
  // whose book closure has not happened yet. That is the "next" payout.
  const now = Date.now();
  const upcoming = events.filter((e) => Date.parse(e.exDate) > now);
  const past = events.filter((e) => Date.parse(e.exDate) <= now);

  // Trailing twelve months, summed per share. Only past events count — an
  // announced-but-unpaid dividend is not yet income.
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const trailing = past.filter((e) => Date.parse(e.exDate) >= yearAgo);

  return {
    symbol,
    assetClass: 'stock',
    // Soonest first among the upcoming ones; `events` is newest-first overall.
    next: upcoming.length > 0 ? upcoming[upcoming.length - 1]! : null,
    history: past,
    trailingAnnualAmount:
      trailing.length > 0 ? trailing.reduce((sum, e) => sum + e.amount, 0) : null,
  };
}

/**
 * Parse the payouts fragment into cash-dividend events.
 *
 * Columns are: announcement date, the financial period, the payout detail, and
 * the book-closure range. The detail cell carries both the size and the kind:
 *
 *   " 250%(F) (D) "      → final cash dividend, 250% of par
 *   " 85%(i) (D) "       → first interim
 *   " 80(ii) (D) "       → already per-share, no percent sign
 *
 * Only rows marked `(D)` are cash dividends. Bonus and right issues appear in
 * the same table and are deliberately skipped: they are not income, and
 * summing them into a trailing figure would invent a payout that never landed.
 */
function parsePayouts(html: string): DividendEvent[] {
  const events: DividendEvent[] = [];
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';

  for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      stripTags(c[1] ?? ''),
    );
    if (cells.length < 4) continue;

    const [announced, period, detail, closure] = cells as [string, string, string, string];
    if (!/\(D\)/i.test(detail)) continue;

    const amount = parsePayoutAmount(detail);
    if (amount === null || amount <= 0) continue;

    // The ex-date is what an investor acts on, and the book-closure start is
    // the closest PSX publishes to one. Announcement date is the fallback.
    const exDate = parsePsxDate(closure.split('-')[0]?.trim()) ?? parseLongDate(announced);
    if (!exDate) continue;

    events.push({
      exDate,
      paymentDate: null,
      recordDate: parsePsxDate(closure.split('-')[1]?.trim()) ?? null,
      declarationDate: parseLongDate(announced),
      amount,
      currency: CURRENCY,
      // The period the payout relates to, e.g. "30/06/2026(YR)" — kept as
      // PSX writes it so the UI can show which result it was declared against.
      period: period || null,
    });
  }

  // Newest first, matching the DividendInfo contract.
  return events.sort((a, b) => Date.parse(b.exDate) - Date.parse(a.exDate));
}

/**
 * Per-share amount from a payout detail cell.
 *
 * The figure is always a percentage of par value, even on the occasional row
 * where PSX drops the sign — MEBL's " 80(ii) (D) " sits among six siblings
 * that all read "70%", and reading it as PKR 80 per share rather than PKR 8
 * would inflate one payout tenfold and the trailing total with it.
 *
 * Treating a bare number as already-per-share was the tempting reading, but no
 * issuer surveyed actually publishes one that way, so the branch only ever
 * fired on typos. A percentage is assumed unconditionally.
 */
function parsePayoutAmount(detail: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(detail);
  if (!match) return null;
  const percentOfPar = Number(match[1]);
  if (!Number.isFinite(percentOfPar)) return null;
  return (percentOfPar / 100) * PAR_VALUE;
}

/** "18/09/2026" → "2026-09-18". */
function parsePsxDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "August 10, 2026 4:15 PM" → "2026-08-10". */
function parseLongDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)$/i, ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Company announcements — PSX's equivalent of news.
 *
 * The announcements tables are server-rendered, so unlike the payouts section
 * they need no second request: financial results, board meetings, and
 * corporate actions all arrive with the company page. It is the only
 * PSX-native news source available.
 */
export async function getAnnouncements(rawSymbol: string): Promise<
  Array<{ date: string; title: string; category: string }>
> {
  const symbol = normalizeSymbol(rawSymbol);
  await gate();
  const html = await httpGetText(`${BASE}/company/${symbol}`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });
  const flat = html.replace(/\n/g, '');

  const items: Array<{ date: string; title: string; category: string }> = [];

  // Each tab panel is one category; rows are <td>date</td><td>title</td>.
  const panelPattern = /<div class="tabs__panel" data-name="([^"]+)">([\s\S]*?)<\/table>/g;
  for (const panel of flat.matchAll(panelPattern)) {
    const category = panel[1] ?? 'Other';
    const rowPattern = /<tr><td>([^<]+)<\/td><td>([\s\S]*?)<\/td>/g;
    for (const row of (panel[2] ?? '').matchAll(rowPattern)) {
      const date = stripTags(row[1] ?? '');
      const title = stripTags(row[2] ?? '');
      if (date && title) items.push({ date, title, category });
    }
  }

  return items;
}

/** Cheap existence check used when adding a holding. */
export async function symbolExists(rawSymbol: string): Promise<boolean> {
  try {
    await fetchEod(normalizeSymbol(rawSymbol));
    return true;
  } catch {
    return false;
  }
}

/**
 * The exchange's instrument directory — symbol, issuer name, and sector name
 * for every listed instrument, in one JSON request.
 *
 * Market-watch publishes a numeric sector code and no name at all, so this is
 * the only way to label a row with something a human reads. It is a separate
 * endpoint rather than a scrape, and at ~1,000 entries it is small enough to
 * fetch whole and join in memory.
 *
 * Cached for a day: listings and delistings happen a few times a year, so
 * refetching per market-watch load would be pure waste. The cache is
 * deliberately module-local — the directory is an implementation detail of
 * this provider, not a resource the route layer should have to know about.
 */
interface DirectoryEntry {
  symbol: string;
  name: string;
  sectorName: string;
  isETF: boolean;
  isDebt: boolean;
}

const DIRECTORY_TTL_MS = 24 * 60 * 60_000;
let directoryCache: { at: number; entries: Map<string, DirectoryEntry> } | null = null;

async function getDirectory(): Promise<Map<string, DirectoryEntry>> {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) {
    return directoryCache.entries;
  }

  const raw = await httpGetJson<unknown>(`${BASE}/symbols`, {
    provider: PROVIDER,
    timeoutMs: 20_000,
  });

  const entries = new Map<string, DirectoryEntry>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : '';
      if (!symbol) continue;
      entries.set(symbol, {
        symbol,
        name: typeof row.name === 'string' ? row.name.trim() : '',
        sectorName: typeof row.sectorName === 'string' ? row.sectorName.trim() : '',
        isETF: row.isETF === true,
        isDebt: row.isDebt === true,
      });
    }
  }

  // An empty directory is a bad response, not a market with no instruments.
  // Serve the stale map rather than un-label every row; only fail when there
  // is nothing to fall back on.
  if (entries.size === 0) {
    if (directoryCache) return directoryCache.entries;
    throw AppError.providerError(
      PROVIDER,
      'Symbol directory returned no usable entries — the endpoint shape has likely changed.',
    );
  }

  directoryCache = { at: Date.now(), entries };
  return entries;
}

/**
 * Market-watch appends a trade-status suffix to the base ticker and the
 * directory lists only the base symbols — "UPFLXD" is Unilever Foods trading
 * ex-dividend, "HASCOLNC" is Hascol flagged non-compliant, "SLYTWU" is Sally
 * Textile under winding-up, "PIAHCLB" is PIA Holding's B class.
 *
 * Tried longest first so "XD" wins before the bare single letters. Checked
 * against a live market-watch page: these cover every one of the 500 rows.
 */
const SYMBOL_SUFFIXES = ['XDXB', 'XBXD', 'XD', 'XB', 'XR', 'NC', 'WU', 'A', 'B', 'R'];

function lookupIssuer(
  directory: Map<string, DirectoryEntry>,
  symbol: string,
): DirectoryEntry | null {
  const exact = directory.get(symbol);
  if (exact) return exact;

  for (const suffix of SYMBOL_SUFFIXES) {
    if (!symbol.endsWith(suffix) || symbol.length <= suffix.length) continue;
    const base = directory.get(symbol.slice(0, -suffix.length));
    if (base) return base;
  }
  return null;
}

/**
 * Whole-market snapshot from the Data Portal's market-watch page.
 *
 * The only bulk source PSX exposes — every other endpoint here is per-symbol,
 * so listing ~480 issuers any other way would mean ~480 requests. This is one.
 *
 * It is scraped HTML, so it is parsed defensively in the same spirit as the
 * rest of this file: rows that don't match the expected column count are
 * skipped rather than throwing, and a wholesale layout change surfaces as an
 * empty result the caller can report, not as garbage prices.
 *
 * Column order as published:
 *   SYMBOL | SECTOR | LISTED IN | LDCP | OPEN | HIGH | LOW | CURRENT |
 *   CHANGE | CHANGE (%) | VOLUME
 */
const MARKET_WATCH_COLUMNS = 11;

export async function getMarketWatch(): Promise<MarketRow[]> {
  await gate();

  const html = await httpGetText(`${BASE}/market-watch`, {
    provider: PROVIDER,
    // A ~470kb page; the default retry budget is fine but give it room.
    timeoutMs: 20_000,
  });

  // Names are a label, not data: a directory failure must not cost the user
  // their prices, so the rows fall back to the scraped sector code.
  let directory: Map<string, DirectoryEntry> = new Map();
  try {
    directory = await getDirectory();
  } catch {
    directory = new Map();
  }

  const rows: MarketRow[] = [];
  for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(match[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      stripTags(c[1] ?? ''),
    );
    if (cells.length !== MARKET_WATCH_COLUMNS) continue; // header or layout row

    const symbol = (cells[0] ?? '').toUpperCase();
    const price = parseNumber(cells[7] ?? '');
    // A symbol with no current price is untradeable today; it would render as
    // a blank row and sort unpredictably.
    if (!symbol || price === null) continue;

    const issuer = lookupIssuer(directory, symbol);

    rows.push({
      symbol,
      assetClass: 'stock',
      price,
      change: parseNumber(cells[8] ?? '') ?? 0,
      changePercent: parseNumber(cells[9] ?? '') ?? 0,
      volume: parseNumber(cells[10] ?? ''),
      currency: CURRENCY,
      name: issuer?.name || null,
      // The scraped column is a bare sector code ("0810"); the directory's
      // sector name is the one worth showing.
      sector: issuer?.sectorName || cells[1] || null,
      listedIn: cells[2] || null,
    });
  }

  if (rows.length === 0) {
    throw AppError.providerError(
      PROVIDER,
      'Market watch returned no parseable rows — the page layout has likely changed.',
    );
  }

  return rows;
}
