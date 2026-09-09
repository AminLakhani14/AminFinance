/**
 * Precious metals spot prices via Twelve Data.
 *
 * Twelve Data quotes metals as forex-style pairs — `XAG/USD` is one troy ounce
 * of silver in US dollars — so the unit throughout this provider is the **troy
 * ounce**, never the gram or the tola. Conversion to whatever the holder
 * actually counts in belongs in the client, next to the other display
 * formatting; letting it leak in here would mean two different definitions of
 * "quantity" reaching cost-basis maths.
 *
 * The free tier is 8 requests/minute and 800/day, which the `twelveData`
 * bucket in lib/rateLimit.ts already sits well under. Metals move slowly
 * enough that the route cache absorbs almost all of the traffic anyway.
 */
import type {
  Quote,
  Candle,
  CandleSeries,
  CandleInterval,
} from '@aminfinance/shared';
import { httpGetJson } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';
import { config } from '../config.js';

const BASE = 'https://api.twelvedata.com';
const PROVIDER = 'Twelve Data';

/** Metals are quoted against USD. */
const CURRENCY = 'USD';

/**
 * Symbols we accept, mapped to the Twelve Data pair.
 *
 * An explicit table rather than a pattern: it doubles as the list `classify()`
 * uses to route a symbol here, so an unknown ticker keeps falling through to
 * the stock path instead of being sent to a metals endpoint that will 404.
 */
const PAIRS: Record<string, string> = {
  XAGUSD: 'XAG/USD',
  XAUUSD: 'XAU/USD',
  XPTUSD: 'XPT/USD',
  XPDUSD: 'XPD/USD',
};

/** Human labels, so the UI does not have to know what XAG means. */
const NAMES: Record<string, string> = {
  XAGUSD: 'Silver (spot, troy oz)',
  XAUUSD: 'Gold (spot, troy oz)',
  XPTUSD: 'Platinum (spot, troy oz)',
  XPDUSD: 'Palladium (spot, troy oz)',
};

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace('/', '');
}

export function isCommodity(symbol: string): boolean {
  return normalizeSymbol(symbol) in PAIRS;
}

export function displayName(symbol: string): string {
  return NAMES[normalizeSymbol(symbol)] ?? normalizeSymbol(symbol);
}

export function listSymbols(): string[] {
  return Object.keys(PAIRS);
}

function requirePair(symbol: string): string {
  const pair = PAIRS[normalizeSymbol(symbol)];
  if (!pair) {
    throw AppError.notFound(`${symbol} is not a supported commodity symbol.`);
  }
  return pair;
}

function requireConfigured(): void {
  if (!config.providers.twelveData) {
    throw AppError.notConfigured('Commodity prices', 'TWELVEDATA_API_KEY');
  }
}

async function gate(): Promise<void> {
  try {
    await acquire('twelveData');
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('twelveData'));
  }
}

/**
 * Twelve Data answers with HTTP 200 and a `status: "error"` body for bad
 * symbols, exhausted quota, and invalid keys alike, so the transport layer sees
 * success. Every response has to be inspected rather than trusted.
 */
function assertOk(body: { status?: string; message?: string; code?: number }): void {
  if (body?.status === 'error') {
    const message = body.message ?? 'unknown error';
    if (body.code === 429 || /limit/i.test(message)) {
      throw AppError.rateLimited(PROVIDER, retryAfterSeconds('twelveData'));
    }
    throw AppError.providerError(PROVIDER, message);
  }
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

interface RawQuote {
  status?: string;
  message?: string;
  code?: number;
  close?: string;
  open?: string;
  high?: string;
  low?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  timestamp?: number;
}

export async function getQuote(symbol: string): Promise<Quote> {
  requireConfigured();
  const normalized = normalizeSymbol(symbol);
  const pair = requirePair(normalized);
  await gate();

  const raw = await httpGetJson<RawQuote>(
    `${BASE}/quote?symbol=${encodeURIComponent(pair)}&apikey=${config.keys.twelveData}`,
    { provider: PROVIDER },
  );
  assertOk(raw);

  const price = toNumber(raw.close);
  if (price === null) {
    throw AppError.providerError(PROVIDER, `No price returned for ${pair}.`);
  }

  const previousClose = toNumber(raw.previous_close);
  // `change` is absent on some pairs; derive it rather than reporting zero.
  const change = toNumber(raw.change) ?? (previousClose !== null ? price - previousClose : 0);
  const changePercent =
    toNumber(raw.percent_change) ??
    (previousClose !== null && previousClose !== 0 ? (change / previousClose) * 100 : 0);

  return {
    symbol: normalized,
    assetClass: 'commodity',
    price,
    change,
    changePercent,
    dayHigh: toNumber(raw.high),
    dayLow: toNumber(raw.low),
    dayOpen: toNumber(raw.open),
    previousClose,
    // Spot metals have no meaningful consolidated volume.
    volume: null,
    currency: CURRENCY,
    timestamp: raw.timestamp ? raw.timestamp * 1000 : Date.now(),
  };
}

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  // Sequential on purpose: the free tier's per-minute ceiling is low, and the
  // portfolio holds at most a couple of metals.
  const quotes: Quote[] = [];
  for (const symbol of symbols) {
    quotes.push(await getQuote(symbol));
  }
  return quotes;
}

const TWELVE_INTERVAL: Record<CandleInterval, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
};

interface RawSeries {
  status?: string;
  message?: string;
  code?: number;
  values?: Array<{
    datetime?: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
    volume?: string;
  }>;
}

export async function getCandles(
  symbol: string,
  interval: CandleInterval,
  limit: number,
): Promise<CandleSeries> {
  requireConfigured();
  const normalized = normalizeSymbol(symbol);
  const pair = requirePair(normalized);
  await gate();

  const raw = await httpGetJson<RawSeries>(
    `${BASE}/time_series?symbol=${encodeURIComponent(pair)}` +
      `&interval=${TWELVE_INTERVAL[interval]}&outputsize=${Math.min(limit, 5000)}` +
      `&apikey=${config.keys.twelveData}`,
    { provider: PROVIDER },
  );
  assertOk(raw);

  const candles: Candle[] = (raw.values ?? [])
    .map((row) => {
      const close = toNumber(row.close);
      const time = row.datetime ? Date.parse(`${row.datetime}Z`) : NaN;
      if (close === null || !Number.isFinite(time)) return null;
      return {
        time: Math.floor(time / 1000),
        open: toNumber(row.open) ?? close,
        high: toNumber(row.high) ?? close,
        low: toNumber(row.low) ?? close,
        close,
        volume: toNumber(row.volume) ?? 0,
      };
    })
    .filter((c): c is Candle => c !== null)
    // Twelve Data returns newest first; charts want oldest first.
    .reverse();

  return { symbol: normalized, assetClass: 'commodity', interval, candles };
}
