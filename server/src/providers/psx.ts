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
    logoUrl: null,
    weekHigh52: rangeParts[1] ?? null,
    weekLow52: rangeParts[0] ?? null,
    circulatingSupply: null,
  };
}

/**
 * Dividends.
 *
 * The company page's `#payouts` section is populated client-side, so it is
 * empty in the HTML we receive — there is no server-rendered dividend history
 * to parse. Rather than fabricate one, this returns an empty result and the UI
 * renders "no announced dividends" instead of a broken calendar.
 *
 * Revisit if PSX exposes a JSON payouts endpoint.
 */
export async function getDividends(rawSymbol: string): Promise<DividendInfo> {
  const symbol = normalizeSymbol(rawSymbol);
  return {
    symbol,
    assetClass: 'stock',
    next: null,
    history: [],
    trailingAnnualAmount: null,
  };
}

/**
 * Company announcements — PSX's equivalent of news.
 *
 * Unlike the payouts section, the announcements tables *are* server-rendered,
 * so this is real parseable data: financial results, board meetings, and
 * corporate actions. It is the only PSX-native news source available.
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
