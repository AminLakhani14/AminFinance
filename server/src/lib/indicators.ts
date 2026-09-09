/**
 * Technical indicators over a daily candle series.
 *
 * Pure functions on `Candle[]`, no I/O — the caller supplies bars from
 * whichever provider owns the symbol, so the same maths covers a PSX equity, a
 * Binance pair, and spot silver.
 *
 * Two rules run through the file:
 *
 *  1. Never report an indicator computed from fewer periods than it needs. A
 *     "200-day average" derived from 60 bars is not a weaker signal, it is a
 *     different number wearing the same name, and downstream it would be read
 *     as the real thing. Short series return null.
 *  2. Wilder's smoothing where Wilder defined it (RSI, ATR). Using a simple
 *     mean instead is a common shortcut that produces visibly different values
 *     from every charting package the user might cross-check against.
 *
 * Input is expected oldest-first, which is what every provider here returns
 * after its own normalisation.
 */
import type { Candle, TechnicalSnapshot } from '@aminfinance/shared';

/** Bars in a trading year, near enough for a 52-week window. */
const YEAR_BARS = 252;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

/**
 * Exponential moving average series, seeded with the SMA of the first window.
 *
 * Returns one value per input from index `period - 1` onward; earlier
 * positions are null so the array stays index-aligned with `values`.
 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series[series.length - 1] ?? null;
}

/**
 * Wilder's RSI.
 *
 * The first average is a simple mean of the opening `period` changes; every
 * subsequent one is smoothed by (period - 1)/period. An all-gains window gives
 * no losses to divide by, which is a genuine 100, not an error.
 */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = (closes[i] as number) - (closes[i - 1] as number);
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  let avgGain = mean(gains.slice(0, period));
  let avgLoss = mean(losses.slice(0, period));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + (gains[i] as number)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[i] as number)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(12, 26, 9): fast EMA minus slow EMA, and a signal EMA of that line. */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { line: number; signal: number; histogram: number } | null {
  if (closes.length < slow + signalPeriod) return null;

  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);

  // Defined only where both EMAs exist.
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    macdLine.push(f - s);
  }
  if (macdLine.length < signalPeriod) return null;

  const signal = ema(macdLine, signalPeriod);
  const line = macdLine[macdLine.length - 1] as number;
  if (signal === null) return null;

  return { line, signal, histogram: line - signal };
}

/** Bollinger bands: SMA(period) ± multiplier × population stddev. */
export function bollinger(
  closes: number[],
  period = 20,
  multiplier = 2,
): { upper: number; middle: number; lower: number; percentB: number } | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const middle = mean(window);
  const variance = mean(window.map((v) => (v - middle) ** 2));
  const sd = Math.sqrt(variance);

  const upper = middle + multiplier * sd;
  const lower = middle - multiplier * sd;
  const price = closes[closes.length - 1] as number;
  // Flat series collapse the bands; report mid-band rather than dividing by 0.
  const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);

  return { upper, middle, lower, percentB };
}

/** Wilder's ATR over true ranges. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i] as Candle;
    const prevClose = (candles[i - 1] as Candle).close;
    trueRanges.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)),
    );
  }

  let value = mean(trueRanges.slice(0, period));
  for (let i = period; i < trueRanges.length; i++) {
    value = (value * (period - 1) + (trueRanges[i] as number)) / period;
  }
  return value;
}

/**
 * Nearest swing pivots either side of the current price.
 *
 * A pivot is a bar whose high (or low) is the most extreme within `lookaround`
 * bars on both sides — the simplest definition that survives contact with real
 * data. Support is the highest pivot low below price; resistance the lowest
 * pivot high above it, so both are the levels price would actually reach first.
 */
export function swingLevels(
  candles: Candle[],
  lookaround = 5,
): { support: number | null; resistance: number | null } {
  if (candles.length < lookaround * 2 + 1) return { support: null, resistance: null };

  const price = (candles[candles.length - 1] as Candle).close;
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = lookaround; i < candles.length - lookaround; i++) {
    const window = candles.slice(i - lookaround, i + lookaround + 1);
    const bar = candles[i] as Candle;
    if (window.every((w) => bar.high >= w.high)) pivotHighs.push(bar.high);
    if (window.every((w) => bar.low <= w.low)) pivotLows.push(bar.low);
  }

  const below = pivotLows.filter((v) => v < price);
  const above = pivotHighs.filter((v) => v > price);

  return {
    support: below.length > 0 ? Math.max(...below) : null,
    resistance: above.length > 0 ? Math.min(...above) : null,
  };
}

/** Percent change over `bars` sessions, or null if the series is shorter. */
function changeOver(closes: number[], bars: number): number | null {
  if (closes.length < bars + 1) return null;
  const then = closes[closes.length - 1 - bars] as number;
  const now = closes[closes.length - 1] as number;
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

/**
 * Trend from moving-average structure.
 *
 * Price above a rising 50 and above the 200 is an uptrend; the mirror is a
 * downtrend; anything else is sideways. Deliberately coarse — a finer label
 * would imply a precision the inputs do not support.
 */
function classifyTrend(closes: number[], sma50: number | null, sma200: number | null): TechnicalSnapshot['trend'] {
  const price = closes[closes.length - 1] as number;
  if (sma50 === null) return 'sideways';

  const priorSma50 = sma(closes.slice(0, -10), 50);
  const rising = priorSma50 !== null && sma50 > priorSma50;
  const falling = priorSma50 !== null && sma50 < priorSma50;

  const aboveLong = sma200 === null || price > sma200;
  const belowLong = sma200 === null || price < sma200;

  if (price > sma50 && rising && aboveLong) return 'up';
  if (price < sma50 && falling && belowLong) return 'down';
  return 'sideways';
}

/**
 * Full snapshot for the prompt.
 *
 * Returns null below 20 bars: nothing here would be meaningful, and a snapshot
 * of all-nulls invites the model to fill the silence.
 */
export function computeTechnicals(candles: Candle[]): TechnicalSnapshot | null {
  if (candles.length < 20) return null;

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1] as number;

  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);

  const yearWindow = candles.slice(-YEAR_BARS);
  const high52w = Math.max(...yearWindow.map((c) => c.high));
  const low52w = Math.min(...yearWindow.map((c) => c.low));
  const rangePosition = high52w === low52w ? 0.5 : (price - low52w) / (high52w - low52w);

  const atr14 = atr(candles);
  const { support, resistance } = swingLevels(candles);

  return {
    bars: candles.length,
    sma20: sma(closes, 20),
    sma50,
    sma200,
    rsi14: rsi(closes),
    macd: macd(closes),
    bollinger: bollinger(closes),
    atr14,
    atrPercent: atr14 !== null && price !== 0 ? (atr14 / price) * 100 : null,
    high52w,
    low52w,
    rangePosition,
    support,
    resistance,
    trend: classifyTrend(closes, sma50, sma200),
    changePercent7d: changeOver(closes, 7),
    changePercent30d: changeOver(closes, 30),
    changePercent90d: changeOver(closes, 90),
  };
}
