/**
 * Dividend income across the book: what is coming, and what it yields.
 *
 * PROJECT_PLAN §2.2 planned this and the data has been parsed all along —
 * `psx.getDividends` reads the exchange's payouts table and `parsePayouts`
 * already converts PSX's percent-of-par quoting into an amount per share.
 * What was missing is the portfolio-level view: per-share figures are not an
 * income until they are multiplied by a holding.
 *
 * That multiplication is the whole value here, and it is also where the
 * mistakes live. PSX publishes payouts as "250%", meaning PKR 25 on a PKR 10
 * par value — which is not a yield, and presenting it as one would overstate
 * income by an order of magnitude. This file assumes `amount` has already
 * been converted to per-share currency by the provider, and never re-reads a
 * percentage.
 */
import type { DividendInfo, Holding } from '@aminfinance/shared';

export interface UpcomingDividend {
  symbol: string;
  exDate: string;
  paymentDate: string | null;
  /** Per share, in the issuer's currency. */
  amountPerShare: number;
  quantity: number;
  /** `amountPerShare * quantity`, in the issuer's currency. */
  total: number;
  currency: string;
  /** Days until the ex-date. Negative once it has passed. */
  daysToExDate: number;
  /**
   * True while the payout can still be secured by buying — i.e. the ex-date
   * has not passed. The single most decision-relevant flag here.
   */
  stillCapturable: boolean;
}

export interface DividendIncome {
  symbol: string;
  /** Trailing twelve months per share, from the exchange's payout history. */
  trailingPerShare: number | null;
  /** `trailingPerShare * quantity` — annual income at the current holding. */
  projectedAnnual: number | null;
  /**
   * Income as a percent of what the position *cost*, not of its market price.
   *
   * Yield on cost, deliberately: the market yield answers "what would I get
   * buying today", which is a question about a purchase the user has already
   * made. Against cost basis it answers what their own money is earning.
   */
  yieldOnCostPercent: number | null;
  /** The conventional market yield, for comparison. */
  currentYieldPercent: number | null;
  currency: string;
}

/** Days between today and an ISO date, in whole days. */
function daysUntil(isoDate: string, now: number): number | null {
  const parts = isoDate.split('-').map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  const target = new Date(year, month - 1, day).getTime();
  const today = new Date(now);
  const midnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  return Math.round((target - midnight) / 86_400_000);
}

/**
 * Announced payouts on held positions, soonest first.
 *
 * Only symbols with a live holding produce a row: a dividend on a stock the
 * user does not own is not income, and mixing the two would make the
 * projected total meaningless.
 */
export function upcomingDividends(
  holdings: Holding[],
  dividends: Map<string, DividendInfo>,
  now = Date.now(),
): UpcomingDividend[] {
  const rows: UpcomingDividend[] = [];

  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;
    const info = dividends.get(holding.symbol);
    const next = info?.next;
    if (!next || !Number.isFinite(next.amount) || next.amount <= 0) continue;

    const days = daysUntil(next.exDate, now);
    if (days === null) continue;

    rows.push({
      symbol: holding.symbol,
      exDate: next.exDate,
      paymentDate: next.paymentDate,
      amountPerShare: next.amount,
      quantity: holding.quantity,
      total: next.amount * holding.quantity,
      currency: next.currency || holding.currency,
      daysToExDate: days,
      stillCapturable: days >= 0,
    });
  }

  return rows.sort((a, b) => a.daysToExDate - b.daysToExDate);
}

/** Per-holding income and yields. */
export function dividendIncome(
  holdings: Holding[],
  dividends: Map<string, DividendInfo>,
): DividendIncome[] {
  const rows: DividendIncome[] = [];

  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;
    const info = dividends.get(holding.symbol);
    const trailing = info?.trailingAnnualAmount ?? null;
    if (trailing === null || !Number.isFinite(trailing)) continue;

    const projectedAnnual = trailing * holding.quantity;

    rows.push({
      symbol: holding.symbol,
      trailingPerShare: trailing,
      projectedAnnual,
      // Guarded against a zero cost basis, which is real: a bonus-issue or
      // airdropped position has one, and dividing by it would render Infinity
      // as a yield.
      yieldOnCostPercent:
        holding.averageCost > 0 ? (trailing / holding.averageCost) * 100 : null,
      currentYieldPercent:
        holding.currentPrice > 0 ? (trailing / holding.currentPrice) * 100 : null,
      currency: holding.currency,
    });
  }

  return rows.sort((a, b) => (b.projectedAnnual ?? 0) - (a.projectedAnnual ?? 0));
}

/** Month-by-month income for the calendar chart, from payout history. */
export interface DividendMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Total received in the issuer's currency, summed across symbols. */
  amount: number;
}

/**
 * The last twelve months of actual payouts, bucketed by month.
 *
 * History rather than a forecast: PSX issuers do not publish a payout
 * schedule, so the honest calendar is what was actually paid. Projecting
 * four even quarters from one annual payout would invent three dates.
 */
export function dividendHistoryByMonth(
  holdings: Holding[],
  dividends: Map<string, DividendInfo>,
  now = Date.now(),
): DividendMonth[] {
  const cutoff = now - 365 * 86_400_000;
  const totals = new Map<string, number>();

  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;
    const info = dividends.get(holding.symbol);
    if (!info) continue;

    for (const event of info.history) {
      if (!Number.isFinite(event.amount) || event.amount <= 0) continue;
      const parts = event.exDate.split('-').map(Number);
      const [year, month] = parts;
      if (!year || !month) continue;
      const at = new Date(year, month - 1, 1).getTime();
      if (at < cutoff) continue;

      const key = `${year}-${String(month).padStart(2, '0')}`;
      // Current quantity applied to a historical payout: an approximation,
      // and stated as one in the UI. The exact figure would need the holding
      // as it stood on each ex-date, which the ledger can give but which
      // turns a summary chart into a per-date replay.
      totals.set(key, (totals.get(key) ?? 0) + event.amount * holding.quantity);
    }
  }

  return [...totals.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
