/**
 * Records one net-worth snapshot per day.
 *
 * The `snapshots` table has existed since schema v1 and nothing ever wrote to
 * it. That is why `reconstructHistory` exists: with no stored history, the
 * Analytics page rebuilds a value series from today's quantities and past
 * prices, which shows how *the current book* would have moved rather than what
 * actually happened. Volatility, Sharpe, and max drawdown are all computed
 * over that reconstruction — so a position bought last week is currently
 * treated as though it had been held for a year.
 *
 * One real snapshot per day fixes that going forward. It cannot fix the past,
 * and the UI should keep labelling reconstructed history as reconstructed
 * until enough real days have accumulated.
 *
 * Deliberately *not* a portfolio-only figure: the snapshot records net worth
 * including cash and debts, because the question "what am I worth over time"
 * is the one a history chart is actually asked.
 */
import { useEffect, useRef } from 'react';
import { putSnapshot } from '@/lib/db';
import { useWealth } from './useWealth';

/**
 * Midnight UTC of the instant's day.
 *
 * Snapshots are keyed by this so repeated writes on the same day overwrite
 * rather than append — `putSnapshot` upserts on `id: timestamp`. UTC and not
 * local time, matching the day alignment `metrics.ts` already uses to
 * intersect PSX and Binance series; two definitions of "day" in one dataset
 * would put two rows on the same date.
 */
function utcDayStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function useNetWorthRecorder(): void {
  const { netWorth, investments, investedCost, isLoading, currency } = useWealth();

  // Guards against a second write in the same session. The table upserts by
  // day anyway, so this is about avoiding pointless IndexedDB churn on every
  // price tick, not about correctness.
  const writtenDay = useRef<number | null>(null);

  useEffect(() => {
    if (isLoading) return;
    // A zero book is the pre-onboarding state, not a real valuation. Writing
    // it would put a leading zero in the history that every drawdown
    // calculation would then read as a 100% loss.
    if (investments <= 0 && netWorth <= 0) return;

    const day = utcDayStart(Date.now());
    if (writtenDay.current === day) return;
    writtenDay.current = day;

    void putSnapshot({
      timestamp: day,
      totalValue: netWorth,
      // The positions' actual cost, not their market value. Cash has no cost
      // basis to add: a rupee in the bank cost a rupee, so including it would
      // make every snapshot's implied gain smaller than it was.
      totalCostBasis: investedCost,
    }).catch(() => {
      // A failed snapshot is a missing day in a chart, not a broken app.
      // Retry naturally on the next mount rather than surfacing an error the
      // user cannot act on.
      writtenDay.current = null;
    });
  }, [isLoading, netWorth, investments, investedCost, currency]);
}
