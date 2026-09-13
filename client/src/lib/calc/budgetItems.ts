/**
 * The predefined budget sheet.
 *
 * The page lays these out as themed cards — Salary, Bills, Subscriptions,
 * Personal care — each holding its own line items with an amount box. A month
 * is filled in by typing numbers into the card you are thinking about, rather
 * than scanning one long undifferentiated list.
 *
 * Two levels, deliberately:
 *
 *   item     — what the user recognises paying ("Electricity bill")
 *   category — what it rolls up to for the charts ("Utilities & bills")
 *
 * The charts stay readable because they aggregate on `category`; the sheet
 * stays recognisable because it shows `item`. Collapsing the two would mean
 * either a twelve-slice donut or a sheet that just says "Utilities" and makes
 * the user remember what that covered.
 *
 * Group identity (icon + accent) is defined here too, so a card, its heading,
 * and its total all read as one object rather than three coordinated strings.
 */
import type { BudgetCategory, BudgetEntryKind } from '@aminfinance/shared';

/** Stable group keys. Persisted nowhere, but referenced by layout order. */
export type BudgetGroupId =
  | 'income'
  | 'bills'
  | 'living'
  | 'personal'
  | 'subscriptions'
  | 'family'
  | 'financial'
  | 'lifestyle';

export interface BudgetGroup {
  id: BudgetGroupId;
  label: string;
  /** One line under the heading, to say what belongs here. */
  hint: string;
  /** lucide-react icon name, resolved by the card component. */
  icon: string;
  /**
   * Accent, as a CSS custom property reference.
   *
   * Drawn from the validated chart palette rather than invented per card, so
   * eight cards on one screen keep the separation the palette already
   * guarantees. Income is the one exception: it uses the semantic positive
   * token, because money in is not a categorical series — it is the opposite
   * direction from everything else on the page.
   */
  accent: string;
  /**
   * The same colour as a literal hex.
   *
   * Exports cannot resolve a CSS custom property — Excel and PDF need a real
   * value — and they render on white regardless of the app's theme, so this
   * is the light-mode hex rather than whatever `accent` currently computes to.
   */
  hex: string;
}

export const BUDGET_GROUPS: readonly BudgetGroup[] = [
  {
    id: 'income',
    label: 'Salary & income',
    hint: 'Everything you were paid this month',
    icon: 'Wallet',
    accent: 'var(--positive)',
    hex: '#1baf7a',
  },
  {
    id: 'bills',
    label: 'Home & bills',
    hint: 'Rent and the utilities you cannot skip',
    icon: 'House',
    accent: 'var(--viz-1)',
    hex: '#2a78d6',
  },
  {
    id: 'living',
    label: 'Living & food',
    hint: 'Groceries, fuel, eating out',
    icon: 'ShoppingCart',
    accent: 'var(--viz-2)',
    hex: '#eb6834',
  },
  {
    id: 'personal',
    label: 'Personal care',
    hint: 'Toiletries, grooming, everyday self-care',
    icon: 'Sparkles',
    accent: 'var(--viz-5)',
    hex: '#e87ba4',
  },
  {
    id: 'subscriptions',
    label: 'Subscriptions',
    hint: 'The small recurring charges that add up',
    icon: 'Repeat',
    accent: 'var(--viz-7)',
    hex: '#4a3aa7',
  },
  {
    id: 'family',
    label: 'Family & education',
    hint: 'Dependants, fees, medical',
    icon: 'Users',
    accent: 'var(--viz-3)',
    hex: '#008300',
  },
  {
    id: 'financial',
    label: 'Financial & obligations',
    hint: 'Loans, zakat, money set aside',
    icon: 'Landmark',
    accent: 'var(--viz-4)',
    hex: '#eda100',
  },
  {
    id: 'lifestyle',
    label: 'Lifestyle & other',
    hint: 'Shopping, travel, anything else',
    icon: 'ShoppingBag',
    accent: 'var(--viz-8)',
    hex: '#e34948',
  },
] as const;

export interface BudgetItem {
  /** Stable key. Persisted on entries, so **never** renamed. */
  id: string;
  label: string;
  kind: BudgetEntryKind;
  /** What this item aggregates into on the charts. */
  category: BudgetCategory;
  group: BudgetGroupId;
  /**
   * Shown by default. The long tail stays behind each card's "more" toggle so
   * a card is short enough to fill in without scrolling past rows never used.
   */
  common?: boolean;
}

/**
 * Ordered within each group: the item most people pay first.
 */
export const BUDGET_ITEMS: readonly BudgetItem[] = [
  // ---- Salary & income --------------------------------------------------
  { id: 'salary', label: 'Salary', kind: 'income', category: 'salary', group: 'income', common: true },
  { id: 'bonus', label: 'Bonus / overtime', kind: 'income', category: 'salary', group: 'income', common: true },
  { id: 'business-income', label: 'Business income', kind: 'income', category: 'business', group: 'income', common: true },
  { id: 'freelance-income', label: 'Freelance / side work', kind: 'income', category: 'freelance', group: 'income', common: true },
  { id: 'rental-income', label: 'Rental income', kind: 'income', category: 'rental', group: 'income' },
  { id: 'investment-income', label: 'Profit / dividends', kind: 'income', category: 'investment', group: 'income' },
  { id: 'gift-income', label: 'Gift / other income', kind: 'income', category: 'gift', group: 'income' },
  // Withheld before the money arrives — subtracted from the card's total
  // rather than added to spending. See `BudgetEntryKind`.
  { id: 'income-tax', label: 'Income tax', kind: 'deduction', category: 'tax', group: 'income', common: true },
  { id: 'pension-deduction', label: 'Pension / EOBI', kind: 'deduction', category: 'pension', group: 'income' },
  { id: 'other-deduction', label: 'Other deductions', kind: 'deduction', category: 'other-deduction', group: 'income' },

  // ---- Home & bills -----------------------------------------------------
  { id: 'rent', label: 'Rent', kind: 'expense', category: 'housing', group: 'bills', common: true },
  { id: 'electricity', label: 'Electricity bill', kind: 'expense', category: 'utilities', group: 'bills', common: true },
  { id: 'gas', label: 'Gas bill', kind: 'expense', category: 'utilities', group: 'bills', common: true },
  { id: 'water', label: 'Water bill', kind: 'expense', category: 'utilities', group: 'bills', common: true },
  { id: 'mobile', label: 'Mobile recharge', kind: 'expense', category: 'utilities', group: 'bills', common: true },
  { id: 'internet', label: 'Internet / Wi-Fi', kind: 'expense', category: 'utilities', group: 'bills', common: true },
  { id: 'maintenance', label: 'Maintenance / society fee', kind: 'expense', category: 'housing', group: 'bills' },
  { id: 'help', label: 'Maid / household help', kind: 'expense', category: 'housing', group: 'bills' },

  // ---- Living & food ----------------------------------------------------
  { id: 'groceries', label: 'Groceries', kind: 'expense', category: 'groceries', group: 'living', common: true },
  { id: 'fuel', label: 'Fuel / transport', kind: 'expense', category: 'transport', group: 'living', common: true },
  { id: 'dining', label: 'Dining out', kind: 'expense', category: 'entertainment', group: 'living', common: true },
  { id: 'household-supplies', label: 'Household supplies', kind: 'expense', category: 'groceries', group: 'living', common: true },
  { id: 'vehicle', label: 'Vehicle upkeep', kind: 'expense', category: 'transport', group: 'living' },

  // ---- Personal care ----------------------------------------------------
  // Individually small, collectively not — which is exactly why they get their
  // own card instead of disappearing into "shopping".
  { id: 'toiletries', label: 'Shampoo, soap & bodywash', kind: 'expense', category: 'personal', group: 'personal', common: true },
  { id: 'skincare', label: 'Face & skin care', kind: 'expense', category: 'personal', group: 'personal', common: true },
  { id: 'haircut', label: 'Haircut & salon', kind: 'expense', category: 'personal', group: 'personal', common: true },
  { id: 'cosmetics', label: 'Cosmetics & fragrance', kind: 'expense', category: 'personal', group: 'personal', common: true },
  { id: 'laundry', label: 'Laundry & dry cleaning', kind: 'expense', category: 'personal', group: 'personal' },
  { id: 'gym', label: 'Gym & fitness', kind: 'expense', category: 'personal', group: 'personal' },

  // ---- Subscriptions ----------------------------------------------------
  { id: 'streaming', label: 'Streaming (Netflix etc.)', kind: 'expense', category: 'subscriptions', group: 'subscriptions', common: true },
  { id: 'music', label: 'Music streaming', kind: 'expense', category: 'subscriptions', group: 'subscriptions', common: true },
  { id: 'cloud-software', label: 'Cloud & software', kind: 'expense', category: 'subscriptions', group: 'subscriptions', common: true },
  { id: 'news-subscription', label: 'News & reading', kind: 'expense', category: 'subscriptions', group: 'subscriptions' },
  { id: 'other-subscription', label: 'Other subscriptions', kind: 'expense', category: 'subscriptions', group: 'subscriptions' },

  // ---- Family & education ----------------------------------------------
  { id: 'school-fees', label: 'School / tuition fees', kind: 'expense', category: 'education', group: 'family', common: true },
  { id: 'children', label: "Children's expenses", kind: 'expense', category: 'family', group: 'family', common: true },
  { id: 'family-support', label: 'Parents / family support', kind: 'expense', category: 'family', group: 'family', common: true },
  { id: 'medical', label: 'Medical & medicines', kind: 'expense', category: 'health', group: 'family', common: true },
  { id: 'books', label: 'Books & supplies', kind: 'expense', category: 'education', group: 'family' },

  // ---- Financial & obligations ------------------------------------------
  { id: 'loan', label: 'Loan / instalment', kind: 'expense', category: 'debt', group: 'financial', common: true },
  { id: 'credit-card', label: 'Credit card payment', kind: 'expense', category: 'debt', group: 'financial', common: true },
  { id: 'zakat', label: 'Zakat & charity', kind: 'expense', category: 'charity', group: 'financial', common: true },
  // Money moved to savings is still money out of the month's cash, so it is an
  // expense row. It lands in its own category rather than inflating "other".
  { id: 'savings-transfer', label: 'Savings / investment transfer', kind: 'expense', category: 'investment', group: 'financial', common: true },
  { id: 'insurance', label: 'Insurance', kind: 'expense', category: 'debt', group: 'financial' },

  // ---- Lifestyle & other ------------------------------------------------
  { id: 'shopping', label: 'Shopping & clothing', kind: 'expense', category: 'shopping', group: 'lifestyle', common: true },
  { id: 'entertainment', label: 'Entertainment & outings', kind: 'expense', category: 'entertainment', group: 'lifestyle', common: true },
  { id: 'gifts', label: 'Gifts & occasions', kind: 'expense', category: 'shopping', group: 'lifestyle', common: true },
  { id: 'travel', label: 'Travel', kind: 'expense', category: 'entertainment', group: 'lifestyle' },
  { id: 'other-expense', label: 'Anything else', kind: 'expense', category: 'other', group: 'lifestyle', common: true },
] as const;

const BY_ID = new Map(BUDGET_ITEMS.map((item) => [item.id, item]));

export function budgetItem(id: string): BudgetItem | undefined {
  return BY_ID.get(id);
}

/**
 * The sheet row a free-form entry belongs in, if any.
 *
 * Adding "income, category: salary" through the dialog should fill the Salary
 * box, not create a parallel entry the sheet cannot see. Without this, the
 * amount counts in the totals but every sheet box stays blank — the figures
 * and the form disagree about the same money.
 *
 * Matches the first item of that kind and category. Where several items share
 * a category (electricity, gas and water are all `utilities`) the first is a
 * guess, so callers should prefer an explicit `itemId` when they have one;
 * this is the fallback for entries that only carry a category.
 */
export function itemForCategory(
  kind: BudgetEntryKind,
  category: BudgetCategory,
): BudgetItem | undefined {
  return BUDGET_ITEMS.find((i) => i.kind === kind && i.category === category);
}

/** Groups in display order, each with its items. Empty groups are omitted. */
export function itemGroups(): Array<{ group: BudgetGroup; items: BudgetItem[] }> {
  return BUDGET_GROUPS.map((group) => ({
    group,
    items: BUDGET_ITEMS.filter((item) => item.group === group.id),
  })).filter((g) => g.items.length > 0);
}
