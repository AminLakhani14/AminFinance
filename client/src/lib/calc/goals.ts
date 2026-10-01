/**
 * Goal projections: what a target costs per month, and when it lands.
 *
 * This is where the budget half and the portfolio half of the app finally
 * meet. The rate comes from the budget (`dependable` surplus — see
 * `surplus.ts`), the compounding comes from the portfolio, and the answer is
 * a month count the user can act on.
 *
 * Projections use the *dependable* surplus rather than the median, and that
 * choice is the whole point. Planning against the median overcommits half the
 * time by construction, and a goal tracker that says "8 months" when the
 * honest answer is "8 months if nothing goes wrong, 11 otherwise" is worse
 * than no tracker: it turns a plan into a disappointment on a schedule.
 */
import type { Goal, GoalProjection } from '@aminfinance/shared';

/** Refuse to project beyond this. Past it, the answer is "not at this rate". */
const MAX_PROJECTION_MONTHS = 600;

export interface ProjectionInput {
  goal: Goal;
  /**
   * Monthly contribution the projection assumes — the dependable surplus, or
   * null when there is not enough budget history to establish one.
   */
  monthlyRate: number | null;
  /**
   * Expected annual return on money already set aside, as a percent. Null or
   * zero projects flat, which is the right default: assuming growth makes
   * every goal look closer than it is.
   */
  annualReturnPercent?: number | null;
  now?: number;
}

/**
 * Months to accumulate `remaining` at `monthly`, with optional compounding.
 *
 * Solved iteratively rather than with the closed-form annuity formula. The
 * loop is bounded and cheap, and it sidesteps the formula's failure at a zero
 * rate — which is the default case here, not an edge case.
 */
function monthsToTarget(
  remaining: number,
  monthly: number,
  monthlyReturn: number,
  startingBalance: number,
): number | null {
  if (remaining <= 0) return 0;
  if (monthly <= 0 && monthlyReturn <= 0) return null;

  let balance = startingBalance;
  const target = startingBalance + remaining;

  for (let month = 1; month <= MAX_PROJECTION_MONTHS; month++) {
    balance = balance * (1 + monthlyReturn) + monthly;
    if (balance >= target) return month;
  }

  return null;
}

export function projectGoal(input: ProjectionInput): GoalProjection {
  const { goal, monthlyRate, annualReturnPercent = 0, now = Date.now() } = input;

  const remaining = Math.max(0, goal.targetAmount - goal.saved);

  // Geometric, not `annual / 12`: at 20% a year the arithmetic split
  // overstates monthly growth, and the error compounds over exactly the
  // horizons a goal tracker deals in.
  const monthlyReturn =
    annualReturnPercent && annualReturnPercent > 0
      ? Math.pow(1 + annualReturnPercent / 100, 1 / 12) - 1
      : 0;

  const monthsAtCurrentRate =
    monthlyRate === null
      ? null
      : monthsToTarget(remaining, monthlyRate, monthlyReturn, goal.saved);

  const projectedDate =
    monthsAtCurrentRate === null ? null : addMonths(now, monthsAtCurrentRate);

  /* ---- Against a deadline, if there is one ------------------------- */

  let requiredMonthly: number | null = null;
  let monthsBehind: number | null = null;
  let onTrack: boolean | null = null;

  if (goal.targetDate !== null) {
    const monthsLeft = monthsBetween(now, goal.targetDate);

    if (monthsLeft <= 0) {
      // Deadline reached or passed. "Required monthly" is the whole shortfall
      // — there are no months left to spread it over.
      requiredMonthly = remaining > 0 ? remaining : 0;
      onTrack = remaining <= 0;
      monthsBehind = monthsAtCurrentRate;
    } else {
      // Required contribution ignoring growth. Deliberately conservative:
      // under-saving is the failure mode worth guarding against, and a
      // required figure inflated by assumed returns is the one that causes it.
      requiredMonthly = remaining / monthsLeft;
      if (monthsAtCurrentRate !== null) {
        monthsBehind = monthsAtCurrentRate - monthsLeft;
        onTrack = monthsAtCurrentRate <= monthsLeft;
      }
    }
  }

  return {
    goalId: goal.id,
    remaining,
    monthsAtCurrentRate,
    projectedDate,
    requiredMonthly,
    monthsBehind,
    onTrack,
  };
}

/**
 * Split a monthly rate across goals by priority order.
 *
 * Goals compete for one surplus — funding three in parallel at the full rate
 * each is the arithmetic error a naive tracker makes, and it makes every
 * projection optimistic by however many goals exist. This funds them in the
 * order given, passing on only what is left.
 */
export function allocateAcrossGoals(
  goals: Goal[],
  monthlyRate: number | null,
  annualReturnPercent = 0,
  now = Date.now(),
): Array<{ projection: GoalProjection; allocated: number }> {
  let available = monthlyRate ?? 0;

  return goals.map((goal) => {
    const remaining = Math.max(0, goal.targetAmount - goal.saved);
    // A met goal consumes nothing and must not swallow the surplus.
    const allocated = remaining <= 0 ? 0 : available;
    if (allocated > 0) available = 0;

    return {
      allocated,
      projection: projectGoal({
        goal,
        monthlyRate: monthlyRate === null ? null : allocated,
        annualReturnPercent,
        now,
      }),
    };
  });
}

/** Whole months between two instants, rounded down and floored at zero. */
function monthsBetween(from: number, to: number): number {
  if (to <= from) return 0;
  const a = new Date(from);
  const b = new Date(to);
  const months =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  // Partial month at the end does not count as a month to save in.
  return Math.max(0, b.getDate() >= a.getDate() ? months : months - 1);
}

function addMonths(from: number, months: number): number {
  const d = new Date(from);
  return new Date(d.getFullYear(), d.getMonth() + months, d.getDate()).getTime();
}
