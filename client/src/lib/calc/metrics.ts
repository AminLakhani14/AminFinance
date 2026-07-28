/**
 * Risk and performance metrics.
 *
 * Every function here returns `null` rather than a number when there isn't
 * enough data to compute it honestly. A Sharpe ratio from four data points is
 * noise dressed as insight, and showing it would be worse than showing nothing.
 */
import type { Candle, PortfolioSnapshot } from '@aminfinance/shared';

/** Below this many observations the statistics aren't meaningful. */
const MIN_OBSERVATIONS = 20;
/** PSX trades ~250 days/year; crypto trades every day. Used for annualizing. */
const TRADING_DAYS_STOCK = 250;
const TRADING_DAYS_CRYPTO = 365;

/** Simple period-over-period returns. */
export function toReturns(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev === undefined || curr === undefined || prev === 0) continue;
    returns.push((curr - prev) / prev);
  }
  return returns;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n−1), the right choice for a data sample. */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Annualized volatility as a percent. */
export function volatility(returns: number[], crypto = false): number | null {
  if (returns.length < MIN_OBSERVATIONS) return null;
  const periods = crypto ? TRADING_DAYS_CRYPTO : TRADING_DAYS_STOCK;
  return stdDev(returns) * Math.sqrt(periods) * 100;
}

/**
 * Annualized Sharpe ratio.
 *
 * `riskFreeRatePercent` is an annual figure and is de-annualized before being
 * subtracted from daily returns — mixing the two timeframes is the classic way
 * to get a Sharpe that's off by ~16x.
 */
export function sharpeRatio(
  returns: number[],
  riskFreeRatePercent: number,
  crypto = false,
): number | null {
  if (returns.length < MIN_OBSERVATIONS) return null;
  const periods = crypto ? TRADING_DAYS_CRYPTO : TRADING_DAYS_STOCK;
  const dailyRiskFree = riskFreeRatePercent / 100 / periods;
  const excess = returns.map((r) => r - dailyRiskFree);
  const sd = stdDev(excess);
  if (sd === 0) return null;
  return (mean(excess) / sd) * Math.sqrt(periods);
}

/** Largest peak-to-trough decline, as a negative percent. */
export function maxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0] ?? 0;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = ((value - peak) / peak) * 100;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** Pearson correlation of two equal-length return series. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OBSERVATIONS) return null;

  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = (x[i] ?? 0) - mx;
    const vy = (y[i] ?? 0) - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }

  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? null : num / denom;
}

/**
 * Bucket a candle timestamp to its UTC calendar day.
 *
 * Essential for cross-market alignment: PSX stamps EOD bars at market close
 * (~11:00 UTC) while Binance stamps daily klines at UTC midnight. Intersecting
 * raw epochs finds *zero* common points, so correlation silently reports
 * "not enough data" for a portfolio that has years of it.
 */
function toUtcDay(epochSeconds: number): number {
  return Math.floor(epochSeconds / 86_400) * 86_400;
}

/** Index a series by UTC day, keeping the last close of each day. */
function byUtcDay(candles: Candle[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const candle of candles) map.set(toUtcDay(candle.time), candle.close);
  return map;
}

/**
 * Correlation matrix across symbols.
 *
 * Series are aligned on calendar day before comparing — PSX and crypto trade on
 * different calendars (crypto every day, PSX weekdays only), and correlating
 * index-by-index across a weekend gap would produce a confidently wrong number.
 */
export function correlationMatrix(
  seriesBySymbol: Map<string, Candle[]>,
): { symbols: string[]; values: number[][] } | null {
  const symbols = [...seriesBySymbol.keys()].filter(
    (s) => (seriesBySymbol.get(s)?.length ?? 0) >= MIN_OBSERVATIONS,
  );
  if (symbols.length < 2) return null;

  const dayMaps = new Map(symbols.map((s) => [s, byUtcDay(seriesBySymbol.get(s) ?? [])]));

  const firstMap = dayMaps.get(symbols[0] as string);
  if (!firstMap) return null;
  const commonDates = [...firstMap.keys()]
    .filter((day) => symbols.every((s) => dayMaps.get(s)?.has(day)))
    .sort((a, b) => a - b);

  if (commonDates.length < MIN_OBSERVATIONS) return null;

  const returnsBySymbol = new Map<string, number[]>();
  for (const symbol of symbols) {
    const map = dayMaps.get(symbol);
    const closes = commonDates.map((day) => map?.get(day) ?? 0);
    returnsBySymbol.set(symbol, toReturns(closes));
  }

  const values = symbols.map((rowSymbol) =>
    symbols.map((colSymbol) => {
      if (rowSymbol === colSymbol) return 1;
      const c = correlation(
        returnsBySymbol.get(rowSymbol) ?? [],
        returnsBySymbol.get(colSymbol) ?? [],
      );
      return c ?? 0;
    }),
  );

  return { symbols, values };
}

/** Portfolio value history → the series the metrics above consume. */
export function snapshotValues(snapshots: PortfolioSnapshot[]): number[] {
  return [...snapshots].sort((a, b) => a.timestamp - b.timestamp).map((s) => s.totalValue);
}

/**
 * Reconstruct portfolio value history from holdings and their price history.
 *
 * Used when there aren't enough stored daily snapshots yet — a brand-new
 * install has no history, but the underlying price series does. Quantities are
 * held constant at today's, so this shows how *the current* book would have
 * moved, not actual past performance. The UI labels it accordingly.
 */
export function reconstructHistory(
  holdings: Array<{ symbol: string; quantity: number }>,
  seriesBySymbol: Map<string, Candle[]>,
  fxToDisplay: (value: number, symbol: string) => number,
): PortfolioSnapshot[] {
  const tracked = holdings.filter((h) => (seriesBySymbol.get(h.symbol)?.length ?? 0) > 0);
  if (tracked.length === 0) return [];

  // Same UTC-day alignment as correlation — mixing PSX close stamps with
  // Binance midnight stamps otherwise yields an empty intersection.
  const dayMaps = new Map(
    tracked.map((h) => [h.symbol, byUtcDay(seriesBySymbol.get(h.symbol) ?? [])]),
  );

  const firstMap = dayMaps.get(tracked[0]?.symbol ?? '');
  if (!firstMap) return [];
  const commonDates = [...firstMap.keys()]
    .filter((day) => tracked.every((h) => dayMaps.get(h.symbol)?.has(day)))
    .sort((a, b) => a - b);

  return commonDates.map((day) => {
    let total = 0;
    for (const holding of tracked) {
      const close = dayMaps.get(holding.symbol)?.get(day);
      if (close !== undefined) {
        total += fxToDisplay(close * holding.quantity, holding.symbol);
      }
    }
    return { timestamp: day * 1000, totalValue: total, totalCostBasis: 0 };
  });
}
