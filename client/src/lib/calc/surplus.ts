/**
 * What is actually left over each month, and how much of it can be committed.
 *
 * The budget book answers "what happened in September". This answers the
 * forward-looking question the portfolio side needs: *how much can go in next
 * month*. Those are different numbers, and the gap between them is the point
 * of this file — one good month is not a rate you can plan against.
 *
 * Pure functions over the same `MonthlyPoint[]` the trend chart draws, so the
 * figure on the dashboard and the bars on the budget page can never disagree.
 * Nothing here is persisted, for the reason every other derived value in this
 * app is recomputed: a stored surplus is a surplus that outlives its own rows.
 */
import type { MonthlyPoint } from './budget';

/**
 * Completed months needed before a median is reported at all.
 *
 * Two months is not a rate — it is two numbers, and the median of two is
 * their midpoint, which reads as far more authoritative than it is. Below
 * this the caller gets `reliable: null` and is expected to show the single
 * month as a single month.
 */
const MIN_SAMPLE = 3;

/**
 * How much history the calculation is standing on.
 *
 * Deliberately not `ConfidenceLevel` from `shared/ai.ts`: that field is a
 * model's read on its own reasoning, which can be `high` on one data point.
 * This is a count of months, and conflating the two would let a thin sample
 * inherit a confident-sounding label.
 */
export type SurplusConfidence = 'none' | 'thin' | 'moderate' | 'good';

export interface SurplusRead {
  /** Completed months with recorded activity that fed the calculation. */
  sampleMonths: number;
  /**
   * Typical monthly surplus: the median of completed months' `saved`.
   *
   * Median rather than mean because one bonus or one wedding should not move
   * the planning figure — a mean over four months lets a single outlier carry
   * a quarter of the weight.
   *
   * Null below `MIN_SAMPLE`, and negative when the months genuinely ran at a
   * deficit. Not clamped: a book that spends more than it earns has no
   * investable surplus, and rounding that up to zero would hide it.
   */
  reliable: number | null;
  /** Most recent completed month's surplus, for a month-over-month delta. */
  latest: number | null;
  /**
   * Spread of the monthly surplus, as a median absolute deviation.
   *
   * MAD rather than standard deviation to match the median it qualifies —
   * a deviation measured around a mean would be inflated by exactly the
   * outliers the median was chosen to ignore.
   */
  variance: number | null;
  /** Median monthly spending — the baseline a future runway metric needs. */
  baselineExpenses: number | null;
  /**
   * The figure worth actually committing: `reliable - variance`, floored at 0.
   *
   * Committing the median overcommits half the time by construction, and the
   * cost of that is asymmetric — an investment plan that quietly needs the
   * grocery money is worse than one that leaves a little idle. Subtracting
   * the spread gives a figure a typical month clears.
   */
  dependable: number | null;
  confidence: SurplusConfidence;
}

const EMPTY: SurplusRead = {
  sampleMonths: 0,
  reliable: null,
  latest: null,
  variance: null,
  baselineExpenses: null,
  dependable: null,
  confidence: 'none',
};

/**
 * Read the surplus rate out of a month-by-month trend.
 *
 * `currentMonth` is excluded rather than counted. A month in progress has
 * most of its income booked on day one and only part of its spending
 * recorded, so including it overstates the surplus every month, worst at the
 * start. It is a parameter and not `new Date()` for the same reason
 * `monthlyTrend` takes `now` — a figure this load-bearing has to be testable
 * against fixed input.
 */
export function readSurplus(trend: MonthlyPoint[], currentMonth: string): SurplusRead {
  // Zero-activity months are gaps, not balanced months. `monthlyTrend` emits
  // them so the chart's x-axis stays continuous, which is right for a chart
  // and wrong here: averaging in a month that was never recorded halves the
  // rate. A real month that happened to break even keeps a non-zero income.
  const months = trend.filter(
    (point) =>
      point.month !== currentMonth &&
      (point.income !== 0 || point.expenses !== 0) &&
      Number.isFinite(point.saved),
  );

  if (months.length === 0) return EMPTY;

  const saved = months.map((point) => point.saved);
  const expenses = months.map((point) => point.expenses);

  // Trailing end of the window is the most recent completed month; `trend`
  // arrives oldest-first from `monthlyTrend`.
  const latest = saved[saved.length - 1] ?? null;

  const confidence = confidenceFor(months.length);

  if (months.length < MIN_SAMPLE) {
    return {
      sampleMonths: months.length,
      reliable: null,
      latest,
      variance: null,
      baselineExpenses: median(expenses),
      dependable: null,
      confidence,
    };
  }

  const reliable = median(saved);
  const variance = reliable === null ? null : medianAbsoluteDeviation(saved, reliable);

  return {
    sampleMonths: months.length,
    reliable,
    latest,
    variance,
    baselineExpenses: median(expenses),
    // Floored at zero: a spread wider than the surplus means there is nothing
    // dependable to commit, which is a real answer. A negative "dependable"
    // would invite a caller to render it as an amount to invest.
    dependable:
      reliable === null || variance === null ? null : Math.max(0, reliable - variance),
    confidence,
  };
}

/**
 * Bands, not a scale. The job of this value is to change the *copy* on the
 * tile — below `good`, a median is a hint rather than a rate — so the
 * boundaries are where the wording should change, not evenly spaced.
 */
function confidenceFor(sampleMonths: number): SurplusConfidence {
  if (sampleMonths === 0) return 'none';
  if (sampleMonths < MIN_SAMPLE) return 'thin';
  if (sampleMonths < 6) return 'moderate';
  return 'good';
}

/** Median of a non-empty list. Null on empty, so callers cannot read a 0. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;

  // Copy before sorting: the caller's array is derived from the trend the
  // chart also draws, and sorting it in place would reorder the bars.
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[mid] ?? null;

  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

/** Median of the absolute distances from `center`. */
function medianAbsoluteDeviation(values: number[], center: number): number | null {
  return median(values.map((value) => Math.abs(value - center)));
}
