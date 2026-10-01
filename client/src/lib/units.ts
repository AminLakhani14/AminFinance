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
import { formatQuantity } from './format';

/** One tola in troy ounces — exact. */
export const TROY_OZ_PER_TOLA = 3 / 8;

/** Grams per tola, for anyone weighing rather than counting. */
export const GRAMS_PER_TOLA = 11.6638038;

/**
 * Grams in one troy ounce — exact, by definition.
 *
 * Needed by the zakat calculation, where nisab is defined as a weight in
 * grams (87.48g gold, 612.36g silver) while every spot quote arrives per
 * troy ounce. The full constant rather than a rounded 31.1, because nisab is
 * a yes/no threshold and a book sitting close to it must not cross on a
 * rounding artefact.
 */
export const GRAMS_PER_TROY_OZ = 31.1034768;

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

/**
 * Quantity as the holder thinks of it, for display only.
 *
 * Metals stay stored in troy ounces — that is the unit the spot quote and the
 * cost basis share — but a Pakistani holder counts silver in tolas, so "7.5"
 * in the Qty column reads as a mistake even when it is exactly right. This
 * renders the tola figure with its unit so the number and its meaning cannot
 * drift apart, and leaves every other asset class alone.
 */
export function formatMetalQuantity(troyOz: number): { text: string; title: string } {
  return {
    text: `${formatTola(troyOz)} tola`,
    title: `${troyOz.toLocaleString(undefined, { maximumFractionDigits: 4 })} troy oz — stored and priced per troy ounce, shown in tola (1 tola = 3/8 troy oz)`,
  };
}

/**
 * Asset-class-aware quantity, so callers never have to remember which classes
 * carry a unit. Returns `title` only when the displayed unit differs from the
 * stored one and the distinction is worth a tooltip.
 */
export function formatHoldingQuantity(
  quantity: number,
  assetClass: string,
): { text: string; title?: string } {
  if (assetClass === 'commodity') return formatMetalQuantity(quantity);
  return { text: formatQuantity(quantity) };
}
