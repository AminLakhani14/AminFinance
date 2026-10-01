/**
 * The whole balance sheet: investments, cash, and debts.
 *
 * `usePortfolio` answers "what are my positions worth". This answers "what am
 * I worth", which is a different question — it needs the cash the portfolio
 * deliberately excludes and the debts it has never known about. Net worth,
 * the emergency-fund runway, and the zakat base all read from here.
 *
 * Cash and liabilities are manual, so every figure carries the date it was
 * last confirmed. A three-week-old bank balance presented as a live net worth
 * is the failure mode this hook is shaped to avoid.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CashAccount, Liability } from '@aminfinance/shared';
import { db } from '@/lib/db';
import { usePortfolio } from '@/features/portfolio/usePortfolio';

export interface WealthState {
  /** Priced positions, in the display currency. */
  investments: number;
  /** What those positions cost — for the snapshot's cost-basis column. */
  investedCost: number;
  /** All cash, in the display currency. */
  cash: number;
  /** Cash marked reachable this week — the runway numerator. */
  liquidCash: number;
  /** Outstanding debt principal. */
  debts: number;
  /** `investments + cash - debts`. */
  netWorth: number;
  accounts: CashAccount[];
  liabilities: Liability[];
  /**
   * Oldest `asOf` across the manual rows, or null when there are none.
   *
   * The whole balance sheet is only as fresh as its stalest input, so this is
   * the single date the UI should show rather than a per-row average that
   * would read as fresher than any actual figure.
   */
  oldestConfirmedAt: number | null;
  isLoading: boolean;
  currency: string;
}

export function useWealth(): WealthState {
  const { summary, convert, displayCurrency, isLoading: portfolioLoading } = usePortfolio();

  const accounts = useLiveQuery(() => db.cash.toArray(), []);
  const liabilities = useLiveQuery(() => db.liabilities.toArray(), []);

  return useMemo(() => {
    const cashRows = accounts ?? [];
    const debtRows = liabilities ?? [];

    let cash = 0;
    let liquidCash = 0;
    for (const account of cashRows) {
      if (!Number.isFinite(account.balance)) continue;
      const value = convert(account.balance, account.currency);
      cash += value;
      if (account.liquid) liquidCash += value;
    }

    let debts = 0;
    for (const row of debtRows) {
      if (!Number.isFinite(row.balance)) continue;
      debts += convert(row.balance, row.currency);
    }

    const confirmations = [...cashRows, ...debtRows]
      .map((row) => row.asOf)
      .filter((at): at is number => Number.isFinite(at));

    const investments = summary.totalValue;

    return {
      investments,
      investedCost: summary.totalCostBasis,
      cash,
      liquidCash,
      debts,
      netWorth: investments + cash - debts,
      accounts: cashRows,
      liabilities: debtRows,
      oldestConfirmedAt: confirmations.length > 0 ? Math.min(...confirmations) : null,
      isLoading: portfolioLoading || accounts === undefined || liabilities === undefined,
      currency: displayCurrency,
    };
  }, [
    accounts,
    liabilities,
    summary.totalValue,
    summary.totalCostBasis,
    convert,
    displayCurrency,
    portfolioLoading,
  ]);
}

/**
 * Months of spending the liquid cash covers.
 *
 * Uses *liquid* cash and median monthly expenses, both deliberately
 * pessimistic: a National Savings certificate is cash for zakat but not
 * reachable in an emergency, and a mean expense figure would be dragged down
 * by an unusually quiet month. Null when there is no expense baseline, since
 * dividing by zero would report infinite runway for someone who simply has
 * not recorded a budget.
 */
export function runwayMonths(
  liquidCash: number,
  medianMonthlyExpenses: number | null,
): number | null {
  if (medianMonthlyExpenses === null || medianMonthlyExpenses <= 0) return null;
  return liquidCash / medianMonthlyExpenses;
}
