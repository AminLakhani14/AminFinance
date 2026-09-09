/**
 * Weight units for precious metals.
 *
 * Metals are *quoted* per troy ounce and *bought*, in Pakistan and India, by
 * the tola. Everything stored in a Transaction is troy ounces, so cost basis
 * and P/L never depend on which unit the buyer happened to think in; these
 * helpers exist purely to convert at the edges — form hints and display.
 *
 * The standard tola is 11.6638038 g and the troy ounce 31.1034768 g, which is
 * exactly 3/8. The ratio is written as that fraction rather than a rounded
 * decimal so 20 tola comes back as precisely 7.5 oz, not 7.499999.
 */

/** One tola in troy ounces — exact. */
export const TROY_OZ_PER_TOLA = 3 / 8;

/** Grams per tola, for anyone weighing rather than counting. */
export const GRAMS_PER_TOLA = 11.6638038;

export function tolaToTroyOz(tola: number): number {
  return tola * TROY_OZ_PER_TOLA;
}

export function troyOzToTola(troyOz: number): number {
  return troyOz / TROY_OZ_PER_TOLA;
}

/**
 * Tola for display: trimmed to at most three decimals, with trailing zeroes
 * removed so a round 20 reads as "20" rather than "20.000".
 */
export function formatTola(troyOz: number): string {
  const tola = troyOzToTola(troyOz);
  return Number(tola.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
