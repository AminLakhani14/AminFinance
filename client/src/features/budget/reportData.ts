/**
 * Report shaping, shared by the Excel and PDF exporters.
 *
 * Both formats must state the same figures — an Excel sheet and a PDF of the
 * same month that disagree is worse than either one alone. So neither exporter
 * computes anything: they both render the structures built here, which in turn
 * come from the same `summarize` the screen uses.
 */
import type { BudgetEntry, BudgetSummary } from '@aminfinance/shared';
import { db } from '@/lib/db';
import {
  byCategory,
  categoryLabel,
  formatMonth,
  shiftMonth,
  summarize,
} from '@/lib/calc/budget';
import { itemGroups, type BudgetGroup, type BudgetItem } from '@/lib/calc/budgetItems';

/** One line item as it appears on a card. */
export interface ReportRow {
  label: string;
  amount: number;
  /** Withheld before the money arrived — shown as a subtraction. */
  isDeduction: boolean;
}

/** One card, mirroring the on-screen group exactly. */
export interface ReportCard {
  group: BudgetGroup;
  rows: ReportRow[];
  /** Gross of non-deduction rows. */
  gross: number;
  /** Sum of deduction rows. */
  withheld: number;
  /** `gross - withheld`, floored at zero — what the card header shows. */
  total: number;
  filledCount: number;
  itemCount: number;
}

export interface MonthReport {
  month: string;
  monthLabel: string;
  currency: string;
  summary: BudgetSummary;
  previous: BudgetSummary;
  cards: ReportCard[];
  /** Spending by chart category, largest first. */
  categories: Array<{ label: string; amount: number; share: number; count: number }>;
  /** Entries with no matching card row. */
  oneOffs: Array<{ label: string; amount: number; kind: BudgetEntry['kind']; date: number }>;
  generatedAt: number;
}

export interface YearReport {
  year: number;
  currency: string;
  months: Array<{
    month: string;
    label: string;
    income: number;
    expenses: number;
    saved: number;
    savingsRate: number | null;
  }>;
  totals: {
    income: number;
    grossIncome: number;
    deductions: number;
    expenses: number;
    saved: number;
    savingsRate: number | null;
    /** Months that actually have data — the divisor for averages. */
    activeMonths: number;
  };
  /** Whole-year spending by category. */
  categories: Array<{ label: string; amount: number; share: number }>;
  /** Per-card yearly totals, so the yearly view keeps the card structure. */
  cardTotals: Array<{ group: BudgetGroup; total: number }>;
  generatedAt: number;
}

/** Build one card from a group's items and this month's amounts. */
function buildCard(
  group: BudgetGroup,
  items: BudgetItem[],
  amounts: Map<string, BudgetEntry>,
): ReportCard {
  const rows: ReportRow[] = [];
  let gross = 0;
  let withheld = 0;
  let filledCount = 0;

  for (const item of items) {
    const amount = amounts.get(item.id)?.amount ?? 0;
    const isDeduction = item.kind === 'deduction';
    if (amount > 0) {
      filledCount++;
      if (isDeduction) withheld += amount;
      else gross += amount;
    }
    rows.push({ label: item.label, amount, isDeduction });
  }

  return {
    group,
    rows,
    gross,
    withheld,
    total: Math.max(0, gross - withheld),
    filledCount,
    itemCount: items.length,
  };
}

export async function buildMonthReport(
  month: string,
  currency: string,
): Promise<MonthReport> {
  const entries = await db.budget.where('month').equals(month).toArray();
  const previousEntries = await db.budget
    .where('month')
    .equals(shiftMonth(month, -1))
    .toArray();

  const amounts = new Map<string, BudgetEntry>();
  for (const entry of entries) {
    if (entry.itemId) amounts.set(entry.itemId, entry);
  }

  const cards = itemGroups().map(({ group, items }) =>
    buildCard(group, items, amounts),
  );

  const summary = summarize(entries, month, currency);

  return {
    month,
    monthLabel: formatMonth(month),
    currency,
    summary,
    previous: summarize(previousEntries, shiftMonth(month, -1), currency),
    cards,
    categories: byCategory(entries, 'expense').map((c) => ({
      label: categoryLabel(c.category),
      amount: c.amount,
      share: c.share,
      count: c.count,
    })),
    oneOffs: entries
      .filter((e) => !e.itemId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((e) => ({
        label: e.label ?? categoryLabel(e.category),
        amount: e.amount,
        kind: e.kind,
        date: e.timestamp,
      })),
    generatedAt: Date.now(),
  };
}

export async function buildYearReport(
  year: number,
  currency: string,
): Promise<YearReport> {
  const all = await db.budget.toArray();
  const inYear = all.filter((e) => e.month.startsWith(`${year}-`));

  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const monthEntries = inYear.filter((e) => e.month === key);
    const s = summarize(monthEntries, key, currency);
    return {
      month: key,
      label: formatMonth(key),
      income: s.income,
      expenses: s.expenses,
      saved: s.saved,
      savingsRate: s.savingsRate,
    };
  });

  // A year total is not the sum of monthly take-homes if computed naively —
  // summarize over every entry at once gives the same answer and keeps the
  // deduction handling in one place.
  const yearSummary = summarize(inYear, `${year}`, currency);

  const activeMonths = months.filter(
    (m) => m.income > 0 || m.expenses > 0,
  ).length;

  const categories = byCategory(inYear, 'expense').map((c) => ({
    label: categoryLabel(c.category),
    amount: c.amount,
    share: c.share,
  }));

  // Per-card yearly totals, using the same deduction arithmetic as a month.
  const byItem = new Map<string, number>();
  for (const entry of inYear) {
    if (!entry.itemId) continue;
    byItem.set(entry.itemId, (byItem.get(entry.itemId) ?? 0) + entry.amount);
  }

  const cardTotals = itemGroups().map(({ group, items }) => {
    let gross = 0;
    let withheld = 0;
    for (const item of items) {
      const amount = byItem.get(item.id) ?? 0;
      if (item.kind === 'deduction') withheld += amount;
      else gross += amount;
    }
    return { group, total: Math.max(0, gross - withheld) };
  });

  return {
    year,
    currency,
    months,
    totals: {
      income: yearSummary.income,
      grossIncome: yearSummary.grossIncome,
      deductions: yearSummary.deductions,
      expenses: yearSummary.expenses,
      saved: yearSummary.saved,
      savingsRate: yearSummary.savingsRate,
      activeMonths,
    },
    categories,
    cardTotals,
    generatedAt: Date.now(),
  };
}

/** Years that have any data, newest first. Drives the year picker. */
export async function availableYears(): Promise<number[]> {
  const all = await db.budget.toArray();
  const years = new Set<number>();
  for (const entry of all) {
    const year = Number(entry.month.slice(0, 4));
    if (Number.isFinite(year)) years.add(year);
  }
  if (years.size === 0) years.add(new Date().getFullYear());
  return [...years].sort((a, b) => b - a);
}
