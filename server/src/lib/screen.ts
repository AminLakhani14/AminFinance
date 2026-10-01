/**
 * Deterministic market screen for the trading desk.
 *
 * The model is slow and its attention is finite, so it never sees the whole
 * market. This file narrows several hundred instruments to a handful worth a
 * plan, in two passes, with no I/O:
 *
 *  1. Liquidity. Only the most-traded names are considered at all. A setup on
 *     a stock that trades a few thousand shares a day is a setup nobody can
 *     enter or exit at the quoted price, and a "top movers" list without this
 *     cut fills up with exactly those.
 *  2. Setup quality, from the same indicators the model is later shown. The
 *     score favours long-only setups the investor can actually take: an
 *     uptrend that has pulled back towards support, with room to resistance.
 *     It penalises chasing — overbought, pinned to the upper band, or already
 *     under resistance.
 *
 * The score is a filter, not a verdict. It decides who gets asked about; the
 * model still decides whether the answer is "buy" or "avoid".
 */
import type { MarketRow, TechnicalSnapshot } from '@aminfinance/shared';

/**
 * Stablecoins, fiat and wrapped-dollar tokens quoted against USDT.
 *
 * These top every volume list and have no setup to trade — a dollar priced in
 * dollars. Gold-backed tokens (PAXG, XAUT) are left in: they move with the
 * metal and are a legitimate trade.
 */
const NON_TRADABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'PYUSD', 'USDE', 'USD1',
  'RLUSD', 'BFUSD', 'XUSD', 'USDS', 'AEUR', 'EURI', 'EUR', 'GBP', 'TRY', 'BRL',
  'WBTC', 'WBETH', 'BETH', 'STETH',
]);

/** Leveraged tokens decay by construction and are not a hold of any length. */
const LEVERAGED_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;

/** PSX: below this price, tick size alone is a large share of any move. */
const PSX_MIN_PRICE = 10;

/** Base asset of a Binance pair, or null if it does not end in `quote`. */
function baseAsset(symbol: string, quote: string): string | null {
  return symbol.endsWith(quote) && symbol.length > quote.length
    ? symbol.slice(0, -quote.length)
    : null;
}

/**
 * The most-traded PSX equities, by value traded today.
 *
 * Value rather than share volume: a PKR 3 stock trading ten million shares is
 * less liquid in any sense that matters than a PKR 900 stock trading half a
 * million.
 */
export function liquidStocks(rows: MarketRow[], exclude: Set<string>, take: number): MarketRow[] {
  return rows
    .filter(
      (r) =>
        !exclude.has(r.symbol.toUpperCase()) &&
        r.price >= PSX_MIN_PRICE &&
        (r.volume ?? 0) > 0,
    )
    .sort((a, b) => b.price * (b.volume ?? 0) - a.price * (a.volume ?? 0))
    .slice(0, take);
}

/**
 * The most-traded USDT pairs, by 24h quote volume.
 *
 * Binance's `volume` on these rows is already quote volume — USDT traded — so
 * it is a value measure and needs no multiplying by price.
 */
export function liquidCoins(rows: MarketRow[], exclude: Set<string>, take: number): MarketRow[] {
  return rows
    .filter((r) => {
      const symbol = r.symbol.toUpperCase();
      const base = baseAsset(symbol, 'USDT');
      return (
        base !== null &&
        !exclude.has(symbol) &&
        !NON_TRADABLE_BASES.has(base) &&
        !LEVERAGED_SUFFIX.test(base) &&
        (r.volume ?? 0) > 0
      );
    })
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, take);
}

/**
 * How attractive a long entry looks on the daily chart. Higher is better;
 * null when there is too little history to judge.
 *
 * 60 bars is the floor: below it there is no 50-day average, and without one
 * there is no trend to buy a pullback in.
 */
export function setupScore(t: TechnicalSnapshot, price: number): number | null {
  if (t.bars < 60 || t.rsi14 === null || t.sma50 === null) return null;

  let score = 0;

  // Trend is the largest single term: buying a pullback in an uptrend is a
  // setup, buying one in a downtrend is catching a knife.
  if (t.trend === 'up') score += 3;
  else if (t.trend === 'down') score -= 3;
  if (t.sma200 !== null) score += price > t.sma200 ? 1.5 : -1.5;

  // Momentum: reward a cooled-off reading, tolerate a washed-out one, and
  // penalise a stretched one.
  const r = t.rsi14;
  if (r >= 38 && r <= 58) score += 2;
  else if (r < 30) score += 1;
  else if (r > 72) score -= 2.5;
  else if (r > 65) score -= 1;

  if (t.macd && t.macd.histogram > 0) score += 1;

  // Proximity to support, in ATRs, so it means the same for a PKR equity and a
  // dollar coin. Within 1.5 ATR is a defined risk; much further is not.
  if (t.support !== null && t.atr14) {
    const fromSupport = (price - t.support) / t.atr14;
    if (fromSupport >= 0 && fromSupport <= 1.5) score += 2;
    else if (fromSupport > 4) score -= 0.5;
  }

  // Room overhead. A target needs somewhere to go before the next ceiling, and
  // a name pressed up under one almost never clears the 1.5 reward-to-risk bar
  // the model is held to — so it is scored down hard enough to give its
  // shortlist slot to something that can.
  if (t.resistance !== null && t.atr14) {
    const toResistance = (t.resistance - price) / t.atr14;
    if (toResistance >= 2) score += 1;
    else if (toResistance < 1) score -= 2;
  }

  if (t.bollinger) {
    if (t.bollinger.percentB < 0.5) score += 0.5;
    if (t.bollinger.percentB > 1) score -= 1;
  }

  return score;
}

/**
 * Short, factual labels for a chart, shown on the card as chips.
 *
 * Computed rather than asked for so they are identical on every refresh and
 * never contradict the indicator readings the model was given.
 */
export function chartTags(t: TechnicalSnapshot | null, price: number): string[] {
  if (!t) return [];
  const tags: string[] = [];

  tags.push(t.trend === 'up' ? 'Uptrend' : t.trend === 'down' ? 'Downtrend' : 'Sideways');

  if (t.rsi14 !== null) {
    const r = Math.round(t.rsi14);
    tags.push(r >= 70 ? `Overbought (RSI ${r})` : r <= 30 ? `Oversold (RSI ${r})` : `RSI ${r}`);
  }

  if (t.sma200 !== null) tags.push(price >= t.sma200 ? 'Above 200-day avg' : 'Below 200-day avg');

  if (t.support !== null && t.atr14) {
    const fromSupport = (price - t.support) / t.atr14;
    if (fromSupport >= 0 && fromSupport <= 1.5) tags.push('Near support');
  }
  if (t.resistance !== null && t.atr14) {
    const toResistance = (t.resistance - price) / t.atr14;
    if (toResistance >= 0 && toResistance < 1) tags.push('Under resistance');
  }

  if (t.rangePosition !== null) {
    if (t.rangePosition >= 0.9) tags.push('Near 52w high');
    else if (t.rangePosition <= 0.1) tags.push('Near 52w low');
  }

  if (t.macd) tags.push(t.macd.histogram > 0 ? 'MACD rising' : 'MACD falling');

  return tags;
}

/** Advancers, decliners and unchanged across a listing. */
export function breadth(rows: MarketRow[]): { advancers: number; decliners: number; unchanged: number } {
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;
  for (const r of rows) {
    if (r.changePercent > 0) advancers++;
    else if (r.changePercent < 0) decliners++;
    else unchanged++;
  }
  return { advancers, decliners, unchanged };
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * The provider token buckets queue a burst but reject a request that waits
 * longer than a few seconds, so firing forty candle fetches at once would fail
 * the tail of them. A small pool keeps every request inside its bucket's wait.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index] as T) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
