/**
 * Capital-gains and dividend tax over a Pakistani tax year.
 *
 * Two things make this different from the P/L the Portfolio page already
 * shows, and both are reasons it cannot be derived from a calendar total:
 *
 * 1. **The year runs July to June.** A disposal on 15 June and one on 15 July
 *    fall in different tax years, so a Jan-Dec total is wrong for every
 *    position closed in the second half of the year.
 *
 * 2. **The rate depends on filer status**, and the gap between filer and
 *    non-filer is wide enough that showing one figure for both would misstate
 *    the liability substantially.
 *
 * Every rate is a *setting*, never a constant. Pakistan's rates change with
 * each Finance Act, and a hardcoded rate does not fail loudly on 1 July — it
 * quietly keeps returning last year's answer. Storing them as user-maintained
 * values with a date attached makes a stale rate visibly stale.
 *
 * This is an estimate for planning, not a return. CGT on listed securities is
 * withheld at source by the broker (NCCPL), so the figure here is what to
 * expect withheld, and reconciling it against the broker's certificate is
 * still the user's job.
 */
import type {
  FilerStatus,
  RealizedGain,
  TaxSettings,
  TaxYearReport,
  TaxableDisposal,
} from '@aminfinance/shared';

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  filerStatus: 'filer',
  // Starting points only — the Settings copy states plainly that these are
  // user-maintained and must be checked against the current Finance Act.
  cgtPercentFiler: 15,
  cgtPercentNonFiler: 30,
  dividendTaxPercentFiler: 15,
  dividendTaxPercentNonFiler: 30,
  // Pakistan's fiscal year opens in July.
  taxYearStartMonth: 7,
};

/**
 * Bounds of the tax year containing `at`.
 *
 * `startMonth` is 1-12. With 7, a date in June 2026 belongs to the year that
 * opened in July 2025 — which is exactly the off-by-one-year error this
 * function exists to prevent callers from making by hand.
 */
export function taxYearBounds(
  at: number,
  startMonth: number,
): { from: number; to: number; label: string } {
  const date = new Date(at);
  const month = date.getMonth() + 1;
  // Before the start month, the year began in the *previous* calendar year.
  const startYear = month >= startMonth ? date.getFullYear() : date.getFullYear() - 1;

  const from = new Date(startYear, startMonth - 1, 1, 0, 0, 0, 0).getTime();
  // First instant of the next year's start month, minus a millisecond: the
  // inclusive end, without assuming any month length.
  const to = new Date(startYear + 1, startMonth - 1, 1, 0, 0, 0, 0).getTime() - 1;

  // A July-June year is written "2025-26"; a calendar year is just "2025".
  const label =
    startMonth === 1
      ? String(startYear)
      : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

  return { from, to, label };
}

/** Tax years with at least one disposal, newest first. */
export function availableTaxYears(
  gains: RealizedGain[],
  startMonth: number,
): Array<{ label: string; from: number; to: number }> {
  const seen = new Map<string, { label: string; from: number; to: number }>();
  for (const gain of gains) {
    const bounds = taxYearBounds(gain.closedAt, startMonth);
    if (!seen.has(bounds.label)) seen.set(bounds.label, bounds);
  }
  return [...seen.values()].sort((a, b) => b.from - a.from);
}

export function rateFor(settings: TaxSettings, status: FilerStatus): number {
  return status === 'filer' ? settings.cgtPercentFiler : settings.cgtPercentNonFiler;
}

export function dividendRateFor(settings: TaxSettings, status: FilerStatus): number {
  return status === 'filer'
    ? settings.dividendTaxPercentFiler
    : settings.dividendTaxPercentNonFiler;
}

export interface TaxReportInput {
  gains: RealizedGain[];
  settings: TaxSettings;
  /**
   * Currency each symbol trades in, from the transaction ledger.
   *
   * `RealizedGain` carries no currency of its own — it inherits the asset's,
   * and a PKR equity disposal cannot be added to a USDT crypto one without
   * it. Passed in rather than inferred from the asset class, because the
   * class is not a reliable proxy: a US ticker added later would also be
   * `stock` and would not settle in rupees.
   */
  currencyBySymbol: Map<string, string>;
  /** Dividends received inside the window, already in `currency`. */
  dividendIncome?: number;
  /** Convert a gain from its own currency into the reporting currency. */
  convert: (amount: number, currency: string) => number;
  currency: string;
  /** Any timestamp inside the wanted year. Defaults to now. */
  at?: number;
}

/**
 * Build the report for the tax year containing `at`.
 *
 * Gains and losses are totalled separately rather than netted in one pass,
 * because the two figures are separately useful — a year with 400k of gains
 * and 380k of losses is a very different year from one with 20k of gains, and
 * a single net number hides that entirely.
 */
export function buildTaxYearReport(input: TaxReportInput): TaxYearReport {
  const {
    gains,
    settings,
    currencyBySymbol,
    dividendIncome = 0,
    convert,
    currency,
    at = Date.now(),
  } = input;

  const { from, to, label } = taxYearBounds(at, settings.taxYearStartMonth);

  const disposals: TaxableDisposal[] = [];
  let totalGains = 0;
  let totalLosses = 0;

  for (const gain of gains) {
    if (gain.closedAt < from || gain.closedAt > to) continue;

    // Realized figures are stored in the asset's own currency: a USDT crypto
    // disposal and a PKR equity disposal cannot be added without conversion.
    // An unknown symbol falls back to the reporting currency, which converts
    // 1:1 — wrong, but it keeps the disposal visible in the report rather
    // than dropping a taxable event silently.
    const gainCurrency = currencyBySymbol.get(gain.symbol) ?? currency;
    const converted = convert(gain.gain, gainCurrency);

    disposals.push({
      symbol: gain.symbol,
      soldAt: gain.closedAt,
      quantity: gain.quantity,
      proceeds: convert(gain.proceeds, gainCurrency),
      costBasis: convert(gain.costBasis, gainCurrency),
      gain: converted,
      holdingDays: Number.isFinite(gain.holdingPeriodDays)
        ? gain.holdingPeriodDays
        : null,
      currency,
    });

    if (converted >= 0) totalGains += converted;
    else totalLosses += -converted;
  }

  disposals.sort((a, b) => b.soldAt - a.soldAt);

  const netGain = totalGains - totalLosses;
  const appliedRatePercent = rateFor(settings, settings.filerStatus);
  // A net loss carries no liability. Losses can be carried forward under the
  // Ordinance, which this report does not attempt to model — it would need
  // prior years' filed positions, which the app does not hold.
  const estimatedTax = netGain > 0 ? netGain * (appliedRatePercent / 100) : 0;

  const dividendRate = dividendRateFor(settings, settings.filerStatus);

  return {
    taxYear: label,
    from,
    to,
    disposals,
    totalGains,
    totalLosses,
    netGain,
    appliedRatePercent,
    estimatedTax,
    dividendIncome,
    estimatedDividendTax: dividendIncome * (dividendRate / 100),
    filerStatus: settings.filerStatus,
    currency,
  };
}

/**
 * Currency map from the transaction ledger, for `buildTaxYearReport`.
 *
 * Last write wins per symbol, which is correct: a symbol's settlement
 * currency does not change, so any of its transactions answers the question.
 */
export function currencyBySymbolFrom(
  transactions: Array<{ symbol: string; currency: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const tx of transactions) map.set(tx.symbol, tx.currency);
  return map;
}
