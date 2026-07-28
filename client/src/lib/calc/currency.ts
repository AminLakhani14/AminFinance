/**
 * Stablecoin → fiat mapping.
 *
 * Binance prices positions in USDT. Treating it as USD is a deliberate
 * simplification: the peg deviation is orders of magnitude smaller than the
 * daily PKR/USD move, so carrying a separate USDT rate would add complexity
 * without adding accuracy.
 */
const STABLE_TO_FIAT: Record<string, string> = {
  USDT: 'USD',
  USDC: 'USD',
  FDUSD: 'USD',
  BUSD: 'USD',
  DAI: 'USD',
  TUSD: 'USD',
};

export function toFiatCode(code: string): string {
  const upper = code.toUpperCase();
  return STABLE_TO_FIAT[upper] ?? upper;
}

/** Currencies offered in Settings. PKR first — it's the home currency here. */
export const SUPPORTED_CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR'] as const;
