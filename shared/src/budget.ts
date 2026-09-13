/**
 * Monthly budget domain types.
 *
 * Deliberately separate from `Transaction`. A portfolio transaction buys an
 * *asset* — it has a symbol, a quantity, and a cost basis that follows it for
 * years. A salary credit or a grocery bill has none of that: it is a single
 * dated amount against a category, and it is closed the moment it happens.
 *
 * Mixing the two would have forced every cost-basis selector to filter out
 * rows that have no symbol, and forced the budget views to invent one.
 *
 * Like transactions, these live only in the browser (IndexedDB). The server
 * never sees a user's salary.
 */

/**
 * Money in (`income`), money out (`expense`), or withheld (`deduction`).
 *
 * `deduction` exists because tax is neither of the other two. It is not income
 * — it never reaches the account. And it is not an expense — you did not
 * choose to spend it, and counting it as spending would make the savings rate
 * lie: on a 200k package with 20k tax and nothing else, "spent 20k, saved 90%"
 * describes a month that did not happen.
 *
 * Deductions reduce the income they are attached to. Gross salary minus its
 * deductions is what the summary counts as income.
 */
export type BudgetEntryKind = 'income' | 'expense' | 'deduction';

/** What was withheld from a payment before it reached you. */
export type DeductionCategory = 'tax' | 'pension' | 'insurance-deduction' | 'other-deduction';

/**
 * Fixed category set rather than free text.
 *
 * Free-text categories look flexible but make every breakdown unusable —
 * "Food", "food", and "Groceries" become three slices of the same pie. The
 * list covers the common cases; `other` is the escape hatch, and the `note`
 * field carries the specifics.
 */
export type ExpenseCategory =
  | 'housing'
  | 'utilities'
  | 'groceries'
  | 'transport'
  | 'health'
  | 'education'
  | 'family'
  | 'personal'
  | 'subscriptions'
  | 'shopping'
  | 'entertainment'
  | 'debt'
  | 'charity'
  | 'other';

export type IncomeCategory =
  | 'salary'
  | 'business'
  | 'freelance'
  | 'rental'
  | 'investment'
  | 'gift'
  | 'other';

export type BudgetCategory = ExpenseCategory | IncomeCategory | DeductionCategory;

export interface BudgetEntry {
  id: string;
  kind: BudgetEntryKind;
  category: BudgetCategory;
  /** Always positive. `kind` carries the direction. */
  amount: number;
  currency: string;
  /** Epoch ms of the day the money moved. */
  timestamp: number;
  /**
   * `YYYY-MM` of `timestamp`, in local time.
   *
   * Stored and indexed rather than derived at read time: a month view must not
   * scan every entry ever recorded, and deriving it from the timestamp in a
   * Dexie `where` clause is not indexable. Written by the persistence layer so
   * the two can never disagree.
   */
  month: string;
  /** Recurs every month — used to seed the next month, never auto-posted. */
  recurring: boolean;
  /**
   * Id of the predefined line item this row fills in, when it is one.
   *
   * The budget sheet lists standard items ("Electricity bill", "Mobile
   * recharge") and the user types an amount into each. That row needs to find
   * *its own* entry on re-render, which the category cannot do — `utilities`
   * covers electricity, gas, and water at once, so three sheet rows would all
   * match the same category and overwrite each other.
   *
   * Absent on free-form entries added outside the sheet, which is why every
   * aggregation keys on `category` and treats this as presentation detail.
   */
  itemId?: string;
  /** User-supplied name for a custom row, shown instead of the category label. */
  label?: string;
  note?: string;
}

/** A month's totals. Derived at read time; never persisted. */
export interface BudgetSummary {
  month: string;
  /** Take-home: gross income minus what was withheld from it. */
  income: number;
  /** Income before deductions. Equals `income` when nothing was withheld. */
  grossIncome: number;
  /** Tax and other withholdings. Never counted as spending. */
  deductions: number;
  expenses: number;
  /** `income - expenses`. Negative means the month ran a deficit. */
  saved: number;
  /** Saved as a percent of income. `null` when there was no income to divide by. */
  savingsRate: number | null;
  currency: string;
}

/** One slice of a month's spending or earning. */
export interface CategoryTotal {
  category: BudgetCategory;
  amount: number;
  /** Share of the parent total, 0..1. */
  share: number;
  count: number;
}
