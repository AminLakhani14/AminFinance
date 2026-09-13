/**
 * Derived state for one budget month.
 *
 * `useLiveQuery` re-runs the read whenever the `budget` table changes, so
 * adding an expense updates the tiles, the donut, and the trend without any
 * manual invalidation — the same reactivity `usePortfolio` relies on.
 */
import { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { BudgetEntry, BudgetSummary, CategoryTotal } from '@aminfinance/shared';
import { adoptLegacyEntries, db } from '@/lib/db';
import { itemForCategory } from '@/lib/calc/budgetItems';
import { useAppSelector } from '@/app/hooks';
import {
  byCategory,
  monthlyTrend,
  summarize,
  type MonthlyPoint,
} from '@/lib/calc/budget';

export interface BudgetState {
  /** Entries for the selected month, newest first. */
  entries: BudgetEntry[];
  summary: BudgetSummary;
  expenseCategories: CategoryTotal[];
  incomeCategories: CategoryTotal[];
  trend: MonthlyPoint[];
  /** Previous month's totals, for the month-over-month deltas. */
  previous: BudgetSummary;
  isLoading: boolean;
  /** No entries in this month — the empty state, not an error. */
  isEmpty: boolean;
  /** Nothing recorded in any month, ever. Drives the first-run copy. */
  isBookEmpty: boolean;
  /** This month's entries keyed by predefined item id, for the fill-in sheet. */
  itemAmounts: Map<string, BudgetEntry>;
  currency: string;
}

/**
 * Module-level, not component state: the migration must run once per page
 * load, and `useBudget` is mounted by several components. A ref would let each
 * one run its own pass.
 */
let adoptionStarted = false;

export function useBudget(month: string, previousMonth: string): BudgetState {
  // Pull entries written before the sheet existed into their matching boxes.
  // `useLiveQuery` re-renders on the writes, so the sheet fills in without a
  // reload. Idempotent, so a second mount is a no-op.
  useEffect(() => {
    if (adoptionStarted) return;
    adoptionStarted = true;
    void adoptLegacyEntries((kind, category) => itemForCategory(kind, category)?.id);
  }, []);

  // Budget figures are entered in whatever the user is paid in, which for this
  // book is the display currency. No FX conversion here: unlike a portfolio,
  // the entries are not quoted in a foreign market.
  const currency = useAppSelector((s) => s.settings.displayCurrency);

  // Undefined while the first read is in flight — that is the loading signal,
  // distinct from an empty array, which means "read, and there is nothing".
  const entries = useLiveQuery(
    () => db.budget.where('month').equals(month).reverse().sortBy('timestamp'),
    [month],
  );

  const previousEntries = useLiveQuery(
    () => db.budget.where('month').equals(previousMonth).toArray(),
    [previousMonth],
  );

  // The trend strip needs the whole book. It is a handful of rows per month,
  // so reading all of them is cheaper than twelve indexed queries.
  const allEntries = useLiveQuery(() => db.budget.toArray(), []);

  const rows = useMemo(() => entries ?? [], [entries]);

  const summary = useMemo(
    () => summarize(rows, month, currency),
    [rows, month, currency],
  );

  const previous = useMemo(
    () => summarize(previousEntries ?? [], previousMonth, currency),
    [previousEntries, previousMonth, currency],
  );

  // Derived from the same rows the sheet's writes update, so a typed amount
  // flows back to its own box without a second query.
  const itemAmounts = useMemo(() => {
    const map = new Map<string, BudgetEntry>();
    for (const row of rows) {
      if (row.itemId) map.set(row.itemId, row);
    }
    return map;
  }, [rows]);

  const expenseCategories = useMemo(() => byCategory(rows, 'expense'), [rows]);
  const incomeCategories = useMemo(() => byCategory(rows, 'income'), [rows]);
  const trend = useMemo(() => monthlyTrend(allEntries ?? [], 12), [allEntries]);

  return {
    entries: rows,
    summary,
    expenseCategories,
    incomeCategories,
    trend,
    previous,
    isLoading: entries === undefined,
    isEmpty: entries !== undefined && rows.length === 0,
    isBookEmpty: allEntries !== undefined && allEntries.length === 0,
    itemAmounts,
    currency,
  };
}
