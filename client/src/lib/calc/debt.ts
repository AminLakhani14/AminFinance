/**
 * Debt repayment: turning a monthly instalment into a shrinking principal.
 *
 * Before this, a debt was two numbers that never met — a principal recorded
 * in Planning and an instalment typed into the Expenses sheet, with nothing
 * connecting them. Paying the loan every month for a year left the principal
 * exactly where it started.
 *
 * The design constraint that shapes everything here is **idempotence**. The
 * budget sheet is a form, not an event log: a user types 12,000, corrects it
 * to 10,000, adds a dated payment, deletes it. If each of those writes
 * subtracted from the balance, the debt would fall by the sum of every
 * keystroke rather than by what was actually paid.
 *
 * So the balance is never decremented. Each month's cumulative repayment is
 * stored as one row, and the principal is *recomputed* from the original less
 * the sum of those rows. Re-running it any number of times gives the same
 * answer, which is what makes it safe to call on every edit.
 */
import type { DebtRepayment, Liability } from '@aminfinance/shared';

/** Split one payment into the part that clears debt and the part that does not. */
export interface PaymentSplit {
  principal: number;
  interest: number;
}

/**
 * Apply one month's interest, then the payment.
 *
 * Interest accrues on the balance *before* the payment lands, which is how
 * amortisation actually works — paying on the 28th does not avoid the month's
 * interest. An absent rate means interest-free, not unknown, so the whole
 * payment reduces the principal.
 *
 * When a payment does not even cover the month's interest, `principal` is
 * zero rather than negative: the debt is growing, and the UI needs to say so
 * rather than quietly recording a negative repayment.
 */
export function splitPayment(
  payment: number,
  balance: number,
  annualRatePercent: number | undefined,
): PaymentSplit {
  if (!Number.isFinite(payment) || payment <= 0) {
    return { principal: 0, interest: 0 };
  }

  if (!annualRatePercent || annualRatePercent <= 0) {
    // Interest-free: every rupee reduces the debt, capped at what remains so
    // an overpayment cannot drive the balance below zero.
    return { principal: Math.min(payment, Math.max(0, balance)), interest: 0 };
  }

  // Simple monthly interest on the outstanding balance. Not compounded within
  // the month, matching how a monthly instalment is quoted.
  const monthlyRate = annualRatePercent / 100 / 12;
  const interest = Math.max(0, balance) * monthlyRate;

  if (payment <= interest) {
    // The payment did not cover the interest. Nothing comes off the principal.
    return { principal: 0, interest: payment };
  }

  const principal = Math.min(payment - interest, Math.max(0, balance));
  return { principal, interest: payment - principal };
}

/**
 * Recompute a debt's balance from its original principal and every repayment.
 *
 * Replays the repayment history in month order rather than summing it, because
 * interest depends on the balance at the time: the same 12,000 payment clears
 * more principal in year three than in year one, and a flat sum would miss
 * that entirely.
 *
 * Returns the recomputed rows alongside the balance, since replaying can
 * change an earlier month's split — editing January's payment changes
 * February's opening balance and therefore February's interest.
 */
export function replayRepayments(
  liability: Pick<Liability, 'balance' | 'originalBalance' | 'annualRatePercent'>,
  repayments: DebtRepayment[],
): { balance: number; rows: DebtRepayment[] } {
  // Without an original, the current balance is the only anchor available and
  // replay would have nothing to subtract from. Treat it as the starting
  // point, which makes this a no-op rather than a wrong answer.
  const original = liability.originalBalance ?? liability.balance;

  const ordered = [...repayments].sort((a, b) => a.month.localeCompare(b.month));
  let balance = original;
  const rows: DebtRepayment[] = [];

  for (const repayment of ordered) {
    const split = splitPayment(
      repayment.amountPaid,
      balance,
      liability.annualRatePercent,
    );
    balance = Math.max(0, balance - split.principal);
    rows.push({
      ...repayment,
      principalPaid: split.principal,
      interestPaid: split.interest,
    });
  }

  return { balance, rows };
}

export interface DebtProgress {
  /** Outstanding principal. */
  balance: number;
  /** What it started at. */
  original: number;
  /** Principal cleared so far. */
  paidOff: number;
  /** 0-100. */
  percentPaid: number;
  /** Total interest paid to date. Zero on an interest-free debt. */
  interestPaid: number;
  /**
   * Months to clear at the recent payment rate, or null when it cannot be
   * established — no payment history, or payments that do not cover interest.
   */
  monthsRemaining: number | null;
  /** Epoch ms the debt clears at that rate, or null. */
  projectedClearDate: number | null;
  /** The payment rate the projection assumes. */
  typicalPayment: number | null;
  /** True when payments are not keeping up with interest. */
  growing: boolean;
}

/** Months averaged for the "at this rate" projection. */
const RATE_WINDOW = 3;

/** Refuse to project past this; beyond it the answer is "not at this rate". */
const MAX_MONTHS = 600;

/**
 * Progress and a projected clear date.
 *
 * The payment rate is the median of the last few months rather than the mean,
 * so one double payment or one skipped month does not move the date much —
 * the same reasoning the budget surplus uses.
 */
export function debtProgress(
  liability: Pick<Liability, 'balance' | 'originalBalance' | 'annualRatePercent'>,
  repayments: DebtRepayment[],
  now = Date.now(),
): DebtProgress {
  const original = liability.originalBalance ?? liability.balance;
  const balance = liability.balance;
  const paidOff = Math.max(0, original - balance);
  const interestPaid = repayments.reduce((sum, r) => sum + r.interestPaid, 0);

  const recent = [...repayments]
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, RATE_WINDOW)
    .map((r) => r.amountPaid)
    .filter((amount) => amount > 0);

  const typicalPayment = recent.length > 0 ? median(recent) : null;

  let monthsRemaining: number | null = null;
  let growing = false;

  if (balance <= 0) {
    monthsRemaining = 0;
  } else if (typicalPayment !== null) {
    const monthlyRate = (liability.annualRatePercent ?? 0) / 100 / 12;
    let remaining = balance;
    let months = 0;

    while (remaining > 0 && months < MAX_MONTHS) {
      const split = splitPayment(typicalPayment, remaining, liability.annualRatePercent);
      if (split.principal <= 0) {
        // The payment does not cover the interest, so the debt never clears.
        growing = remaining * monthlyRate > typicalPayment;
        months = MAX_MONTHS;
        break;
      }
      remaining -= split.principal;
      months++;
    }

    monthsRemaining = months >= MAX_MONTHS ? null : months;
  }

  return {
    balance,
    original,
    paidOff,
    percentPaid: original > 0 ? Math.min(100, (paidOff / original) * 100) : 0,
    interestPaid,
    monthsRemaining,
    projectedClearDate:
      monthsRemaining === null || monthsRemaining === 0
        ? null
        : addMonths(now, monthsRemaining),
    typicalPayment,
    growing,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

function addMonths(from: number, months: number): number {
  const d = new Date(from);
  return new Date(d.getFullYear(), d.getMonth() + months, d.getDate()).getTime();
}
