/**
 * Keyless precious-metals fallback.
 *
 * Exists so metals work out of the box. The Twelve Data path in metals.ts is
 * better data, but it needs a key, and an unconfigured key made every commodity
 * request fail with `provider_not_configured` — a 503 on the Market page for
 * anyone who had not signed up.
 *
 * Two upstreams, because no single keyless source covers both needs:
 *
 *   - Spot quotes: api.gold-api.com. Genuine spot, updated continuously, no
 *     key. Quote only — its /history endpoint is authenticated.
 *   - OHLC history: Yahoo's chart endpoint, via the COMEX/NYMEX futures
 *     contracts (SI=F, GC=F, PL=F, PA=F).
 *
 * The seam matters: futures are **not** spot. The front month carries carry
 * cost, so silver futures print ~1% above spot. Mixing them would make a
 * chart's last candle disagree with the quote beside it. So quotes come from
 * spot and only the *shape* of history comes from futures — and `getCandles`
 * rebases that shape onto the live spot price so the two agree on screen.
 *
 * Unit is the troy ounce throughout, matching metals.ts.
 */
import type { Quote, Candle, CandleSeries, CandleInterval } from '@aminfinance/shared';
import { httpGetJson } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';

const PROVIDER = 'Spot metals (keyless)';
const CURRENCY = 'USD';

const GOLD_API = 'https://api.gold-api.com/price';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** Our symbol -> gold-api spot code. */
const SPOT_CODE: Record<string, string> = {
  XAGUSD: 'XAG',
  XAUUSD: 'XAU',
  XPTUSD: 'XPT',
  XPDUSD: 'XPD',
};

/**
 * Our symbol -> Yahoo futures ticker.
 *
 * Spot FX-style tickers (XAGUSD=X) are not served by this endpoint — they 404 —
 * so the futures contracts are the only keyless OHLC available.
 */
const FUTURES_TICKER: Record<string, string> = {
  XAGUSD: 'SI=F',
  XAUUSD: 'GC=F',
  XPTUSD: 'PL=F',
  XPDUSD: 'PA=F',
};

const YAHOO_INTERVAL: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '1h',
  '1d': '1d',
  '1w': '1wk',
};

/**
 * Yahoo takes a range, not a bar count, so ask for a window comfortably wider
 * than `limit` and trim. Intraday ranges are capped by what Yahoo will serve
 * for that granularity.
 */
const YAHOO_RANGE: Record<CandleInterval, string> = {
  '1m': '5d',
  '5m': '1mo',
  '15m': '1mo',
  '1h': '3mo',
  '4h': '6mo',
  '1d': '2y',
  '1w': '10y',
};

export function isSupported(symbol: string): boolean {
  return symbol.toUpperCase() in SPOT_CODE;
}

async function gate(): Promise<void> {
  try {
    await acquire('metalsFree');
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('metalsFree'));
  }
}

interface RawSpot {
  price?: number;
  symbol?: string;
  name?: string;
  updatedAt?: string;
}

/**
 * Spot quote.
 *
 * gold-api returns a price and nothing else — no open, no previous close — so
 * the day's change is filled in from the futures series, which tracks spot
 * closely enough in *percentage* terms even though its absolute level differs.
 * When that second call fails the quote still returns, with nulls rather than a
 * fabricated zero change.
 */
export async function getQuote(symbol: string): Promise<Quote> {
  const normalized = symbol.toUpperCase();
  const code = SPOT_CODE[normalized];
  if (!code) throw AppError.notFound(`${symbol} is not a supported commodity symbol.`);

  await gate();
  const raw = await httpGetJson<RawSpot>(`${GOLD_API}/${code}`, {
    provider: PROVIDER,
    timeoutMs: 12_000,
  });

  const price = typeof raw.price === 'number' && Number.isFinite(raw.price) ? raw.price : null;
  if (price === null) {
    throw AppError.providerError(PROVIDER, `No spot price returned for ${normalized}.`);
  }

  const daily = await dailyContext(normalized).catch(() => null);

  // Percentage move is taken from futures; the absolute change is then derived
  // against the spot price so the two numbers are internally consistent.
  const changePercent = daily?.changePercent ?? null;
  const change = changePercent !== null ? (price * changePercent) / 100 : null;
  const previousClose = change !== null ? price - change : null;

  const scale = daily && daily.close > 0 ? price / daily.close : null;

  return {
    symbol: normalized,
    assetClass: 'commodity',
    price,
    change: change ?? 0,
    changePercent: changePercent ?? 0,
    // Intraday extremes are rebased from futures onto the spot level for the
    // same reason as the candles below.
    dayHigh: daily && scale ? daily.high * scale : null,
    dayLow: daily && scale ? daily.low * scale : null,
    dayOpen: daily && scale ? daily.open * scale : null,
    previousClose,
    volume: null,
    currency: CURRENCY,
    timestamp: raw.updatedAt ? Date.parse(raw.updatedAt) || Date.now() : Date.now(),
  };
}

interface YahooChart {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}

async function fetchYahoo(ticker: string, interval: string, range: string): Promise<YahooChart> {
  const raw = await httpGetJson<YahooChart>(
    `${YAHOO_CHART}/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
    { provider: PROVIDER, timeoutMs: 15_000 },
  );
  const error = raw.chart?.error;
  if (error) {
    throw AppError.providerError(PROVIDER, error.description ?? error.code ?? 'chart error');
  }
  if (!raw.chart?.result?.[0]) {
    throw AppError.providerError(PROVIDER, `No history returned for ${ticker}.`);
  }
  return raw;
}

/** The current session's OHLC and percent move, from the futures contract. */
async function dailyContext(
  symbol: string,
): Promise<{ open: number; high: number; low: number; close: number; changePercent: number }> {
  const ticker = FUTURES_TICKER[symbol];
  if (!ticker) throw AppError.notFound(`No futures ticker for ${symbol}.`);

  await gate();
  const raw = await fetchYahoo(ticker, '1d', '5d');
  const result = raw.chart!.result![0]!;
  const quote = result.indicators?.quote?.[0];
  const closes = (quote?.close ?? []).filter((c): c is number => typeof c === 'number');
  if (closes.length === 0) throw AppError.providerError(PROVIDER, 'No closes in futures series.');

  const last = closes.length - 1;
  const close = closes[last]!;
  const prev = closes.length > 1 ? closes[last - 1]! : (result.meta?.chartPreviousClose ?? close);

  const idx = (quote?.close ?? []).lastIndexOf(close);
  const pick = (arr: Array<number | null> | undefined): number =>
    typeof arr?.[idx] === 'number' ? (arr[idx] as number) : close;

  return {
    open: pick(quote?.open),
    high: pick(quote?.high),
    low: pick(quote?.low),
    close,
    changePercent: prev > 0 ? ((close - prev) / prev) * 100 : 0,
  };
}

/**
 * OHLC history.
 *
 * The series is futures, so every bar is shifted onto the spot level by a
 * single ratio (spot / latest futures close) before returning. That keeps the
 * chart's right edge equal to the quote shown next to it, which is the number
 * the user actually recognises, while preserving the true shape of the move.
 *
 * A failed spot lookup is not fatal — the unscaled futures series is still a
 * correct chart of the metal, just at the futures level.
 */
export async function getCandles(
  symbol: string,
  interval: CandleInterval,
  limit: number,
): Promise<CandleSeries> {
  const normalized = symbol.toUpperCase();
  const ticker = FUTURES_TICKER[normalized];
  if (!ticker) throw AppError.notFound(`${symbol} is not a supported commodity symbol.`);

  await gate();
  const raw = await fetchYahoo(ticker, YAHOO_INTERVAL[interval], YAHOO_RANGE[interval]);

  const result = raw.chart!.result![0]!;
  const stamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};

  let candles: Candle[] = stamps
    .map((time, i): Candle | null => {
      const close = quote.close?.[i];
      if (typeof close !== 'number' || !Number.isFinite(close)) return null;
      const num = (v: number | null | undefined): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : close;
      return {
        time,
        open: num(quote.open?.[i]),
        high: num(quote.high?.[i]),
        low: num(quote.low?.[i]),
        close,
        volume: num(quote.volume?.[i]) === close ? 0 : (quote.volume?.[i] ?? 0),
      };
    })
    .filter((c): c is Candle => c !== null);

  // 4h is not a Yahoo granularity; fold 1h bars into groups of four.
  if (interval === '4h') candles = aggregate(candles, 4);

  const spot = await getSpot(normalized).catch(() => null);
  const lastClose = candles.at(-1)?.close;
  if (spot !== null && lastClose && lastClose > 0) {
    const scale = spot / lastClose;
    candles = candles.map((c) => ({
      ...c,
      open: c.open * scale,
      high: c.high * scale,
      low: c.low * scale,
      close: c.close * scale,
    }));
  }

  return {
    symbol: normalized,
    assetClass: 'commodity',
    interval,
    candles: candles.slice(-limit),
  };
}

/** Bare spot price, used to rebase the futures series. */
async function getSpot(symbol: string): Promise<number | null> {
  const code = SPOT_CODE[symbol];
  if (!code) return null;
  await gate();
  const raw = await httpGetJson<RawSpot>(`${GOLD_API}/${code}`, {
    provider: PROVIDER,
    timeoutMs: 12_000,
  });
  return typeof raw.price === 'number' && Number.isFinite(raw.price) ? raw.price : null;
}

/** Fold N consecutive bars into one, preserving true OHLC semantics. */
function aggregate(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    if (group.length === 0) continue;
    out.push({
      time: group[0]!.time,
      open: group[0]!.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}
