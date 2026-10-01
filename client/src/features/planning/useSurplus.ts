/**
 * The monthly investable surplus, read from the budget book.
 *
 * Thin by design: `useBudget` already reads every entry to build the trend
 * strip, and `readSurplus` is a pure pass over that same series — so the
 * figure on the dashboard and the bars on the budget page cannot disagree.
 */
import { useMemo } from 'react';
import { useBudget } from '@/features/budget/useBudget';
import { currentMonth, shiftMonth } from '@/lib/calc/budget';
import { readSurplus, type SurplusRead } from '@/lib/calc/surplus';

export interface SurplusState extends SurplusRead {
  currency: string;
  isLoading: boolean;
}

export function useSurplus(): SurplusState {
  const month = currentMonth();
  const previous = shiftMonth(month, -1);

  // Note: `useBudget` kicks off the one-time legacy-entry adoption on mount.
  // Mounting it here means that migration runs when the dashboard opens
  // rather than on first visit to the budget page. It is guarded by a
  // module-level flag, so a second consumer is a no-op.
  const { trend, currency, isLoading, previous: previousSummary } = useBudget(month, previous);

  const read = useMemo(() => readSurplus(trend, month), [trend, month]);

  return {
    ...read,
    // Previous month's actual saving, for a month-over-month delta. The tile
    // must compare against this and not against `reliable` — an ordinary
    // month sits either side of its own median, so a delta-vs-median would
    // render half of all normal months as a decline.
    latest: read.latest ?? (previousSummary.income > 0 ? previousSummary.saved : null),
    currency,
    isLoading,
  };
}
