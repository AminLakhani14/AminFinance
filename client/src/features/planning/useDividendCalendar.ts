/**
 * Dividend data for every held equity, fanned out across one query per symbol.
 *
 * `/api/dividends/:symbol` is per-symbol, so this pads the request list to a
 * fixed length and skips the empty slots — the same technique
 * `useCandleSeries` uses, and for the same reason: hook order must not change
 * between renders as the holdings list shifts.
 *
 * Twelve rather than the candle hook's eight. That cap exists because the
 * chart palette runs out of distinguishable colours; this list is a table and
 * a calendar, so the only cost of another symbol is another cached request
 * against a 24-hour TTL.
 */
import { useMemo } from 'react';
import type { DividendInfo } from '@aminfinance/shared';
import { marketApi } from '@/services/endpoints';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import {
  dividendHistoryByMonth,
  dividendIncome,
  upcomingDividends,
  type DividendIncome,
  type DividendMonth,
  type UpcomingDividend,
} from '@/lib/calc/dividends';

const MAX_TRACKED = 12;

export interface DividendCalendarState {
  upcoming: UpcomingDividend[];
  income: DividendIncome[];
  byMonth: DividendMonth[];
  /** Sum of `projectedAnnual`, converted to the display currency. */
  projectedAnnualTotal: number;
  /** Portfolio-wide yield on cost, as a percent. Null without cost data. */
  portfolioYieldOnCost: number | null;
  isLoading: boolean;
  /** No held equity pays a dividend the exchange has reported. */
  isEmpty: boolean;
  currency: string;
}

export function useDividendCalendar(): DividendCalendarState {
  const { holdings, convert, displayCurrency } = usePortfolio();

  // Only equities pay dividends; crypto and metals never will, and querying
  // them would waste a request per symbol on a guaranteed 404-equivalent.
  const equities = useMemo(
    () => holdings.filter((h) => h.assetClass === 'stock' && h.quantity > 0),
    [holdings],
  );

  const padded = useMemo(() => {
    const list = equities.slice(0, MAX_TRACKED).map((h) => h.symbol);
    while (list.length < MAX_TRACKED) list.push('');
    return list;
  }, [equities]);

  const queries = padded.map((symbol) =>
    // Safe: `padded` is always MAX_TRACKED long, so the hook count is fixed.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    marketApi.useGetDividendsQuery(symbol, { skip: !symbol }),
  );

  const isLoading = queries.some((q, i) => Boolean(padded[i]) && q.isLoading);

  const dividends = useMemo(() => {
    const map = new Map<string, DividendInfo>();
    padded.forEach((symbol, index) => {
      const data = queries[index]?.data;
      if (symbol && data) map.set(symbol, data);
    });
    return map;
    // Keyed on content rather than the query objects, which are rebuilt each
    // render — the same approach `useSparklines` takes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padded.join(','), queries.map((q) => (q.data ? '1' : '0')).join('')]);

  return useMemo(() => {
    const upcoming = upcomingDividends(equities, dividends);
    const income = dividendIncome(equities, dividends);
    const byMonth = dividendHistoryByMonth(equities, dividends);

    // Converted per row: a PSX payout is in PKR and a future US holding would
    // not be, so summing the raw figures would add unlike currencies.
    const projectedAnnualTotal = income.reduce(
      (sum, row) => sum + convert(row.projectedAnnual ?? 0, row.currency),
      0,
    );

    // Portfolio yield on cost: total projected income over total cost basis.
    // Computed from the converted totals rather than averaging the per-holding
    // percentages, which would weight a tiny position equally with a large one.
    const totalCost = equities.reduce(
      (sum, h) => sum + convert(h.costBasis, h.currency),
      0,
    );

    return {
      upcoming,
      income,
      byMonth,
      projectedAnnualTotal,
      portfolioYieldOnCost:
        totalCost > 0 ? (projectedAnnualTotal / totalCost) * 100 : null,
      isLoading,
      isEmpty: !isLoading && income.length === 0 && upcoming.length === 0,
      currency: displayCurrency,
    };
  }, [equities, dividends, convert, displayCurrency, isLoading]);
}
