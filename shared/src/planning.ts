/**
 * Planning domain: cash balances, zakat, capital-gains tax, and goals.
 *
 * These are deliberately in one file rather than folded into `portfolio.ts` or
 * `budget.ts`, because they all share one property that neither of those has:
 * they describe *obligations and intentions*, not recorded facts. A holding is
 * something you own; a zakat liability is something you owe on it, computed
 * against a threshold that moves with the silver price. Mixing the two would
 * put a fatwa-dependent number next to a broker-reconciled one.
 *
 * Like the rest of the user's book, everything here lives in the browser. A
 * salary, a zakat liability, and a savings goal are the three most private
 * numbers in this app, and none of them reaches the server.
 */

/* ------------------------------------------------------------------ *
 * Cash
 * ------------------------------------------------------------------ */

/**
 * Where liquid money sits, when it is not a priced position.
 *
 * This exists because the portfolio deliberately has no room for it:
 * `reconcile.ts` drops stablecoin balances during Binance sync on the grounds
 * that they are "cash, not a position" — correct, since there is no pair to
 * price them against, but it left the app unable to answer how much cash the
 * user holds. Three features need that answer: zakat (cash is fully
 * zakatable), emergency-fund runway (months of expenses covered), and net
 * worth (a portfolio total is not a net worth).
 *
 * Manual rather than synced. Pakistani bank accounts have no retail API, so
 * a stored balance with the date it was last confirmed is the honest maximum
 * — and `asOf` is what lets the UI say "as of 3 weeks ago" rather than
 * implying it is live.
 */
export type CashAccountKind =
  | 'bank'
  | 'cash-on-hand'
  | 'mobile-wallet'
  | 'stablecoin'
  | 'savings-certificate'
  | 'other';

export interface CashAccount {
  id: string;
  label: string;
  kind: CashAccountKind;
  balance: number;
  currency: string;
  /** Epoch ms the balance was last confirmed by the user. */
  asOf: number;
  /**
   * Counted toward the emergency-fund runway.
   *
   * A National Savings certificate is cash for zakat purposes but is not
   * reachable this week, so treating every balance as emergency liquidity
   * would overstate the runway — the one number whose job is to be
   * pessimistic.
   */
  liquid: boolean;
  /**
   * Excluded from zakatable wealth.
   *
   * The escape hatch for money held on someone else's behalf — a committee
   * pool, a deposit being forwarded. Zakat is owed on what you own, and
   * counting a pass-through balance inflates the liability.
   */
  excludeFromZakat?: boolean;
  note?: string;
}

/**
 * A debt owed. Reduces zakatable wealth and net worth alike.
 *
 * Separate from the budget's `loan` expense row, which records a monthly
 * *instalment*. The instalment is cash flow; this is the outstanding
 * principal. Deriving one from the other is not possible without an interest
 * schedule, and guessing at it would put a fabricated number into a zakat
 * calculation.
 */
export interface Liability {
  id: string;
  label: string;
  /** Outstanding principal, always positive. */
  balance: number;
  currency: string;
  asOf: number;
  /**
   * The budget sheet row whose payments pay this debt down, e.g. `loan`.
   *
   * When set, recording an amount against that row in the monthly sheet
   * reduces `balance` — which is what turns two disconnected numbers (a
   * principal in Planning, an instalment in Expenses) into one debt that
   * actually shrinks as it is paid.
   *
   * Absent on a debt paid outside the budget, or before the user links it.
   */
  linkedItemId?: string;
  /**
   * Annual interest rate as a percent, or absent for an interest-free debt.
   *
   * Absent is the default and the common case here: a family loan carries no
   * interest, so the whole payment reduces the principal. On a bank loan it
   * does not — part of each instalment is interest and never touches the
   * balance — and applying the full amount would show the debt clearing years
   * early. Absent means "interest-free", never "unknown".
   */
  annualRatePercent?: number;
  /**
   * Original principal, for progress. Set when the debt is created and left
   * alone afterwards, so "PKR 144,000 of 200,000 left" stays truthful even
   * after the balance is edited by hand.
   */
  originalBalance?: number;
  /**
   * Deductible from zakatable wealth.
   *
   * Scholars differ on long-term debt: the common position is that only
   * debts due within the zakat year reduce the base, so a 20-year mortgage
   * does not wipe out the liability. Defaults to true for short-term debt
   * and is the user's call for the rest.
   */
  deductibleFromZakat: boolean;
  note?: string;
}

/**
 * What a debt was paid in one month, and what that did to the principal.
 *
 * Exists to make the link *idempotent*. The budget sheet is a form: a user
 * types 12,000, corrects it to 10,000, then logs a second payment. If each
 * write subtracted from the balance, those three edits would take 34,000 off
 * a debt that received 10,000. Instead this records the month's cumulative
 * repayment, and the balance is recomputed as `original - sum(principalPaid)`
 * — so re-running it any number of times lands on the same answer.
 *
 * `interestPaid` is split out rather than folded away because it is the part
 * that never reduces the debt. Showing a 12,000 payment against a balance
 * that fell by 9,400 is confusing until the other 2,600 is named.
 */
export interface DebtRepayment {
  id: string;
  liabilityId: string;
  /** `YYYY-MM`, matching the budget month that produced it. */
  month: string;
  /** Total paid that month, as recorded in the budget sheet. */
  amountPaid: number;
  /** The share that reduced the principal. Equals `amountPaid` when interest-free. */
  principalPaid: number;
  /** The share absorbed by interest. Zero on an interest-free debt. */
  interestPaid: number;
  currency: string;
  /** Epoch ms this repayment was last recomputed. */
  recordedAt: number;
}

/* ------------------------------------------------------------------ *
 * Zakat
 * ------------------------------------------------------------------ */

/**
 * Which metal sets the nisab threshold.
 *
 * This is not a cosmetic preference — it decides *whether zakat is owed at
 * all*. The silver nisab (612.36g) is worth roughly a sixth of the gold one
 * (87.48g) at modern prices, so a mid-size book crosses the silver threshold
 * and not the gold one. The app defaults to silver, the more commonly
 * recommended basis for mixed-asset wealth and the one that errs toward
 * paying, but it must never silently pick for the user.
 */
export type NisabBasis = 'silver' | 'gold';

/**
 * How listed equities enter the zakat base.
 *
 * `market-value` treats the whole position as zakatable — the simpler and
 * most commonly applied view for shares held as an investment rather than
 * for trading. `zakatable-portion` counts only the issuer's share of liquid
 * and current assets, which is more precise but requires balance-sheet data
 * PSX DPS does not publish, so it falls back to a user-supplied percentage.
 *
 * Exposed as a setting because it is a fiqh position, not a fact, and the
 * difference between the two can be several multiples.
 */
export type EquityZakatTreatment = 'market-value' | 'zakatable-portion';

export interface ZakatSettings {
  nisabBasis: NisabBasis;
  equityTreatment: EquityZakatTreatment;
  /**
   * Share of an equity position counted when `equityTreatment` is
   * `zakatable-portion`, 0..100. Ignored under `market-value`.
   */
  equityZakatablePercent: number;
  /**
   * Zakat rate as a percent. 2.5 on the lunar year — settable only because
   * the solar-year equivalent is 2.577, which a user reporting on a Gregorian
   * year may prefer.
   */
  ratePercent: number;
  /**
   * Start of the user's zakat year, as `MM-DD` in the Hijri-anniversary sense
   * the user tracks it by, or null when they have not set one.
   *
   * Stored as a plain anniversary rather than a computed Hijri date: doing
   * Hijri arithmetic properly needs a calendar library and local moon-sighting
   * convention, and getting it subtly wrong would shift someone's obligation
   * by days. The user knows their own date.
   */
  anniversary: string | null;
}

/** One line of the zakat base, so the total is always auditable. */
export interface ZakatLine {
  label: string;
  /** Contribution in the display currency. Negative for deductions. */
  amount: number;
  /**
   * Why this line is what it is — the equity treatment applied, the debt
   * deducted, the balance excluded. Shown in the UI so a surprising total can
   * be traced to the rule that produced it.
   */
  note: string | null;
}

/**
 * A computed zakat position.
 *
 * Every field is derived and nothing is persisted, for the reason the rest of
 * this app recomputes: a stored liability outlives the silver price it was
 * measured against, and a stale nisab is the one error that flips `due` from
 * false to true.
 */
export interface ZakatAssessment {
  /** Total zakatable wealth after deductions, in `currency`. */
  netWealth: number;
  /** Threshold in `currency`, from the live metal price. */
  nisab: number;
  /** Weight of metal the nisab is defined as, in grams. */
  nisabGrams: number;
  /** Price per gram used, so the threshold can be checked by hand. */
  nisabPricePerGram: number | null;
  basis: NisabBasis;
  /** `netWealth >= nisab`. False means nothing is owed. */
  due: boolean;
  /** `netWealth * ratePercent / 100`, or 0 when not due. */
  amount: number;
  ratePercent: number;
  /** Assets, then deductions, in display order. */
  lines: ZakatLine[];
  currency: string;
  /**
   * What could not be valued — an unpriced holding, a cash account in a
   * currency with no FX rate. Surfaced rather than dropped: a silently
   * omitted asset understates an obligation.
   */
  excluded: Array<{ label: string; reason: string }>;
  /** Epoch ms the assessment was computed. */
  asOf: number;
}

/* ------------------------------------------------------------------ *
 * Capital gains tax
 * ------------------------------------------------------------------ */

/**
 * Filer status under Pakistan's Income Tax Ordinance.
 *
 * Drives the withholding rate on both capital gains and dividends, and the
 * gap is large enough that showing one rate for both would misstate the
 * liability by a wide margin.
 */
export type FilerStatus = 'filer' | 'non-filer';

/**
 * Tax rates, entered by the user rather than shipped as constants.
 *
 * Pakistan's rates change with each Finance Act, and a hardcoded rate silently
 * becomes wrong on 1 July. Storing them as settings with the tax year they
 * apply to means a stale figure is visible as stale instead of authoritative.
 * The app ships current-looking defaults purely as a starting point, and the
 * UI must say plainly that they are user-maintained.
 */
export interface TaxSettings {
  filerStatus: FilerStatus;
  /** Capital-gains rate on listed securities, percent. */
  cgtPercentFiler: number;
  cgtPercentNonFiler: number;
  /** Withholding on dividends, percent. */
  dividendTaxPercentFiler: number;
  dividendTaxPercentNonFiler: number;
  /**
   * Month the tax year starts, 1-12. Pakistan's runs July-June, so this is 7
   * — a setting because the same report is useful on a calendar year
   * elsewhere, and hardcoding July would make it wrong rather than localized.
   */
  taxYearStartMonth: number;
}

/** One disposal in the tax-year report. */
export interface TaxableDisposal {
  symbol: string;
  /** Epoch ms of the sale. */
  soldAt: number;
  quantity: number;
  proceeds: number;
  costBasis: number;
  /** `proceeds - costBasis`. Negative for a loss. */
  gain: number;
  /** Days between acquisition and disposal, for holding-period buckets. */
  holdingDays: number | null;
  currency: string;
}

export interface TaxYearReport {
  /** Label such as `2025-26`, matching how PSX and the FBR write it. */
  taxYear: string;
  /** Inclusive bounds, epoch ms. */
  from: number;
  to: number;
  disposals: TaxableDisposal[];
  /** Sum of positive gains. */
  totalGains: number;
  /** Sum of losses, as a positive figure. */
  totalLosses: number;
  /** `totalGains - totalLosses`. */
  netGain: number;
  /** Rate applied, from filer status. */
  appliedRatePercent: number;
  /** Estimated tax on the net gain. Zero when the net is a loss. */
  estimatedTax: number;
  /** Dividends received in the window, and the withholding on them. */
  dividendIncome: number;
  estimatedDividendTax: number;
  filerStatus: FilerStatus;
  currency: string;
}

/* ------------------------------------------------------------------ *
 * Inflation and benchmark rates
 * ------------------------------------------------------------------ */

/**
 * User-maintained economic rates.
 *
 * There is no free, documented, machine-readable feed for Pakistani CPI or
 * National Savings rates. Scraping the statistics bureau would add a second
 * undocumented dependency of exactly the kind PROJECT_PLAN §8 flags as
 * fragile, for data that changes monthly at most. So the user types it, the
 * app stamps it with a date, and every derived figure carries that date — a
 * visibly stale 12% beats an invisibly wrong scrape.
 */
export interface RateSettings {
  /** Year-on-year CPI as a percent, for real-return conversion. */
  inflationPercent: number;
  /** Best available risk-free savings rate, percent — NSC, term deposit. */
  savingsRatePercent: number;
  /** Label for what `savingsRatePercent` refers to, e.g. "Behbood". */
  savingsRateLabel: string;
  /** Epoch ms the user last confirmed these. Drives the staleness warning. */
  updatedAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Goals
 * ------------------------------------------------------------------ */

/**
 * A funding target with a date.
 *
 * `targetDate` is nullable because the two useful questions are opposites:
 * "how much per month to hit Hajj by 2028" needs a date, and "when do I get
 * there at my current surplus" needs the absence of one. Forcing a date would
 * make the second question unaskable.
 */
export interface Goal {
  id: string;
  label: string;
  targetAmount: number;
  currency: string;
  /** Epoch ms, or null for "as soon as the surplus allows". */
  targetDate: number | null;
  /**
   * Already set aside toward this goal.
   *
   * Tracked on the goal rather than inferred from the portfolio, because a
   * goal is a claim on part of the book and there is no way to tell which
   * rupee of FFC is earmarked for Hajj. Inferring it would silently
   * double-count one balance across several goals.
   */
  saved: number;
  createdAt: number;
  note?: string;
}

/** Whether a goal is on track, and what it would take. */
export interface GoalProjection {
  goalId: string;
  /** Remaining to fund. Zero when already met. */
  remaining: number;
  /** Months at the dependable surplus rate, or null when there is no rate. */
  monthsAtCurrentRate: number | null;
  /** Epoch ms the goal is reached at the current rate, or null. */
  projectedDate: number | null;
  /** Required monthly contribution to hit `targetDate`. Null without a date. */
  requiredMonthly: number | null;
  /**
   * Months late against `targetDate` at the current rate. Negative is early,
   * null when either the date or the rate is missing.
   */
  monthsBehind: number | null;
  onTrack: boolean | null;
}
