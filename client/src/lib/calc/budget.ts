/**
 * Monthly budget aggregation.
 *
 * Pure functions over `BudgetEntry[]`. Nothing here is persisted — the same
 * rule the portfolio selectors follow, for the same reason: a stored total is
 * a total that can disagree with its own rows.
 */
import type {
  BudgetCategory,
  BudgetEntry,
  BudgetSummary,
  CategoryTotal,
  ExpenseCategory,
  IncomeCategory,
} from '@aminfinance/shared';

/** Display order for expense categories — essentials first, discretionary last. */
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'housing',
  'utilities',
  'groceries',
  'transport',
  'health',
  'education',
  'family',
  'personal',
  'subscriptions',
  'debt',
  'shopping',
  'entertainment',
  'charity',
  'other',
] as const;

export const INCOME_CATEGORIES: readonly IncomeCategory[] = [
  'salary',
  'business',
  'freelance',
  'rental',
  'investment',
  'gift',
  'other',
] as const;

const LABELS: Record<BudgetCategory, string> = {
  // Expense
  housing: 'Rent & housing',
  utilities: 'Utilities & bills',
  groceries: 'Groceries & food',
  transport: 'Transport & fuel',
  health: 'Health & medical',
  education: 'Education',
  family: 'Family & dependants',
  personal: 'Personal care',
  subscriptions: 'Subscriptions',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  debt: 'Loan & debt payments',
  charity: 'Charity & zakat',
  // Income
  salary: 'Salary',
  business: 'Business',
  freelance: 'Freelance',
  rental: 'Rental income',
  investment: 'Investment income',
  gift: 'Gift',
  // Deductions
  tax: 'Income tax',
  pension: 'Pension / EOBI',
  'insurance-deduction': 'Insurance deduction',
  'other-deduction': 'Other deduction',
  // Shared by both kinds — the one label that has to work either way.
  other: 'Other',
};

export function categoryLabel(category: BudgetCategory): string {
  return LABELS[category] ?? category;
}

/**
 * Totals for one month's entries.
 *
 * `savingsRate` is `null` rather than 0 when income is zero: a month with
 * 40,000 of spending and no recorded salary has an *undefined* savings rate,
 * and rendering it as "0%" would read as "you broke even".
 */
export function summarize(
  entries: BudgetEntry[],
  month: string,
  currency: string,
): BudgetSummary {
  let grossIncome = 0;
  let expenses = 0;
  let deductions = 0;

  for (const entry of entries) {
    if (!Number.isFinite(entry.amount)) continue;
    // Explicit per-kind branching, not an `else`. A catch-all would have
    // silently swept `deduction` into spending the moment the kind was added.
    if (entry.kind === 'income') grossIncome += entry.amount;
    else if (entry.kind === 'deduction') deductions += entry.amount;
    else if (entry.kind === 'expense') expenses += entry.amount;
  }

  // Take-home. Clamped at zero so a mis-typed deduction larger than the salary
  // cannot produce a negative income, which would invert the savings rate.
  const income = Math.max(0, grossIncome - deductions);
  const saved = income - expenses;

  return {
    month,
    income,
    grossIncome,
    deductions,
    expenses,
    saved,
    // Rate is against take-home: you cannot save money that was never paid to
    // you, so dividing by gross would understate every month by the tax rate.
    savingsRate: income > 0 ? (saved / income) * 100 : null,
    currency,
  };
}

/** Per-category totals for one kind, largest first. */
export function byCategory(
  entries: BudgetEntry[],
  kind: BudgetEntry['kind'],
): CategoryTotal[] {
  const totals = new Map<BudgetCategory, { amount: number; count: number }>();

  for (const entry of entries) {
    if (entry.kind !== kind || !Number.isFinite(entry.amount)) continue;
    const current = totals.get(entry.category) ?? { amount: 0, count: 0 };
    totals.set(entry.category, {
      amount: current.amount + entry.amount,
      count: current.count + 1,
    });
  }

  const sum = [...totals.values()].reduce((s, t) => s + t.amount, 0);

  return [...totals.entries()]
    .map(([category, t]) => ({
      category,
      amount: t.amount,
      share: sum > 0 ? t.amount / sum : 0,
      count: t.count,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** A month in the trend strip. */
export interface MonthlyPoint {
  month: string;
  income: number;
  expenses: number;
  saved: number;
}

/**
 * Recent months as a continuous series, ending with the current month.
 *
 * Months with no entries *inside* the window are emitted as zeros rather than
 * skipped — a gap closed up would put February next to April and imply a
 * continuity the data does not have.
 *
 * Leading empty months are trimmed, though, down to `minMonths`. A book with
 * three weeks of history would otherwise render as one bar squeezed against
 * eleven empty columns, spending most of the chart's width saying nothing.
 */
export function monthlyTrend(
  entries: BudgetEntry[],
  limit = 12,
  now = Date.now(),
  minMonths = 6,
): MonthlyPoint[] {
  const totals = new Map<
    string,
    { income: number; expenses: number; deductions: number }
  >();

  for (const entry of entries) {
    const current =
      totals.get(entry.month) ?? { income: 0, expenses: 0, deductions: 0 };
    // Same explicit branching as `summarize` — a deduction is not spending,
    // and drawing it as a red bar would misreport every taxed month.
    if (entry.kind === 'income') current.income += entry.amount;
    else if (entry.kind === 'deduction') current.deductions += entry.amount;
    else if (entry.kind === 'expense') current.expenses += entry.amount;
    totals.set(entry.month, current);
  }

  const anchor = new Date(now);
  const points: MonthlyPoint[] = [];

  for (let back = limit - 1; back >= 0; back--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() - back, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const t = totals.get(key) ?? { income: 0, expenses: 0, deductions: 0 };
    // Plot take-home, matching the tiles. A gross bar would not reconcile with
    // the "saved" figure printed beneath the chart.
    const takeHome = Math.max(0, t.income - t.deductions);
    points.push({
      month: key,
      income: takeHome,
      expenses: t.expenses,
      saved: takeHome - t.expenses,
    });
  }

  // Trim from the left while the oldest month is empty and we are still above
  // the floor. The current month always survives, even when it is empty.
  let start = 0;
  while (
    points.length - start > minMonths &&
    points[start]!.income === 0 &&
    points[start]!.expenses === 0
  ) {
    start++;
  }

  return points.slice(start);
}

/** `2026-09` → `September 2026`. */
export function formatMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return new Date(year, monthNumber - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/** `2026-09` → `Sep`, for axis ticks where the long form would collide. */
export function formatMonthShort(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return new Date(year, monthNumber - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
  });
}

/** Step a `YYYY-MM` key by whole months. Handles year boundaries. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  const d = new Date(year, monthNumber - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Current month as `YYYY-MM`, local time. */
export function currentMonth(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
