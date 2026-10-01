/**
 * Real (inflation-adjusted) returns, and the savings-rate benchmark.
 *
 * The case for this file: with Pakistani CPI running well into double digits,
 * a portfolio reporting "+8% this year" has *lost* purchasing power, and an
 * app that prints +8% in green is telling the user they gained. Nominal
 * return is the number every tracker shows; real return is the number that
 * answers whether the money bought more than it used to.
 *
 * The rates are user-entered. There is no free, documented, machine-readable
 * feed for Pakistani CPI or National Savings rates, and scraping the
 * statistics bureau would add a second undocumented dependency of the kind
 * PROJECT_PLAN §8 already flags as fragile — for data that moves monthly at
 * most. A visibly stale figure the user typed beats an invisibly broken
 * scrape, so every derived number here carries the date of the input.
 */
import type { RateSettings } from '@aminfinance/shared';

export const DEFAULT_RATE_SETTINGS: RateSettings = {
  // Zero, not a guess. A shipped default of "12%" would be indistinguishable
  // from a figure the user had confirmed, and would silently restate every
  // return in the app against a number nobody chose. Zero makes real return
  // equal nominal until the user supplies a rate, which is honest.
  inflationPercent: 0,
  savingsRatePercent: 0,
  savingsRateLabel: 'National Savings',
  updatedAt: null,
};

/** A rate older than this reads as stale — CPI is published monthly. */
const STALE_AFTER_DAYS = 45;

export function ratesAreStale(settings: RateSettings, now = Date.now()): boolean {
  if (settings.updatedAt === null) return settings.inflationPercent !== 0;
  return now - settings.updatedAt > STALE_AFTER_DAYS * 86_400_000;
}

export function daysSinceRateUpdate(
  settings: RateSettings,
  now = Date.now(),
): number | null {
  if (settings.updatedAt === null) return null;
  return Math.floor((now - settings.updatedAt) / 86_400_000);
}

/**
 * Convert a nominal return to a real one via the exact Fisher relation.
 *
 * `(1 + nominal) / (1 + inflation) - 1`, not the `nominal - inflation`
 * approximation. At Pakistani inflation levels the shortcut is materially
 * wrong: 20% nominal against 15% inflation is 4.35% real, not 5%, and the
 * error grows with both rates — precisely the regime this feature exists for.
 */
export function realReturnPercent(
  nominalPercent: number,
  inflationPercent: number,
): number {
  const nominal = nominalPercent / 100;
  const inflation = inflationPercent / 100;
  // Guard the degenerate case: -100% inflation would divide by zero.
  if (inflation <= -1) return nominalPercent;
  return ((1 + nominal) / (1 + inflation) - 1) * 100;
}

/**
 * Purchasing power of an amount after `years` of inflation.
 *
 * Answers "what will today's 1,000,000 be worth when I retire" — the question
 * that makes a long-dated savings goal look very different.
 */
export function purchasingPower(
  amount: number,
  inflationPercent: number,
  years: number,
): number {
  if (inflationPercent <= -100) return amount;
  return amount / Math.pow(1 + inflationPercent / 100, years);
}

/** What a nominal figure must reach to hold its purchasing power. */
export function inflationAdjustedTarget(
  amount: number,
  inflationPercent: number,
  years: number,
): number {
  return amount * Math.pow(1 + inflationPercent / 100, years);
}

export interface BenchmarkComparison {
  /** The portfolio's own return, as given. */
  portfolioPercent: number;
  /** The risk-free savings alternative, from settings. */
  savingsPercent: number;
  savingsLabel: string;
  /** Portfolio minus savings. Negative means the certificate won. */
  excessPercent: number;
  /** Both, restated after inflation. */
  portfolioRealPercent: number;
  savingsRealPercent: number;
  /** True when the risk-free alternative beat the portfolio. */
  savingsWon: boolean;
  /** True when even the savings rate lost to inflation. */
  bothLostToInflation: boolean;
  inflationPercent: number;
}

/**
 * The portfolio against the obvious alternative.
 *
 * For most Pakistani savers the real counterfactual is not cash under the
 * mattress — it is a National Savings certificate or a term deposit at a
 * double-digit rate. A tracker that benchmarks only against its own cost
 * basis never asks whether the risk was paid for.
 */
export function compareToSavings(
  portfolioPercent: number,
  settings: RateSettings,
): BenchmarkComparison {
  const portfolioReal = realReturnPercent(portfolioPercent, settings.inflationPercent);
  const savingsReal = realReturnPercent(
    settings.savingsRatePercent,
    settings.inflationPercent,
  );

  return {
    portfolioPercent,
    savingsPercent: settings.savingsRatePercent,
    savingsLabel: settings.savingsRateLabel,
    excessPercent: portfolioPercent - settings.savingsRatePercent,
    portfolioRealPercent: portfolioReal,
    savingsRealPercent: savingsReal,
    savingsWon: settings.savingsRatePercent > portfolioPercent,
    bothLostToInflation: portfolioReal < 0 && savingsReal < 0,
    inflationPercent: settings.inflationPercent,
  };
}
