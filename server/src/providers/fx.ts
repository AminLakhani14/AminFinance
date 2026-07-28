/**
 * Foreign exchange rates.
 *
 * Needed because the book is split across currencies: PSX holdings are priced
 * in PKR, Binance in USDT. A combined portfolio total is meaningless without a
 * conversion.
 *
 * Source: open.er-api.com — free, no key, daily updates, and it carries PKR
 * (the ECB-backed alternatives do not). Cross-checked against the broker's own
 * implied rate: 277.69 here vs 277.92 implied, a 0.08% spread that reflects
 * Binance pricing USDT itself rather than an error on either side.
 *
 * USDT is treated as 1:1 with USD. It is a dollar-pegged stablecoin, and the
 * peg deviation is far smaller than the daily FX move.
 */
import type { FxRates } from '@aminfinance/shared';
import { httpGetJson } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire } from '../lib/rateLimit.js';

const PROVIDER = 'FX';

interface RawRates {
  result: string;
  base_code: string;
  time_last_update_unix: number;
  rates: Record<string, number>;
}

/** Stablecoins we price as their fiat peg. */
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

export async function getRates(base = 'USD'): Promise<FxRates> {
  const fiatBase = toFiatCode(base);
  try {
    await acquire('fx');
  } catch {
    throw AppError.rateLimited(PROVIDER, 60);
  }

  const raw = await httpGetJson<RawRates>(
    `https://open.er-api.com/v6/latest/${encodeURIComponent(fiatBase)}`,
    { provider: PROVIDER, timeoutMs: 12_000 },
  );

  if (raw.result !== 'success' || !raw.rates) {
    throw AppError.providerError(PROVIDER, 'Exchange-rate provider returned no rates.');
  }

  return {
    base: fiatBase,
    rates: raw.rates,
    timestamp: (raw.time_last_update_unix ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

/**
 * Convert an amount between currencies using a rates table based on `USD`.
 * Returns null when either side is unknown, so callers can show "—" rather
 * than a silently wrong number.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  rates: FxRates,
): number | null {
  const fromCode = toFiatCode(from);
  const toCode = toFiatCode(to);
  if (fromCode === toCode) return amount;

  const base = rates.base;
  // rates maps 1 base -> N of key.
  const fromRate = fromCode === base ? 1 : rates.rates[fromCode];
  const toRate = toCode === base ? 1 : rates.rates[toCode];
  if (!fromRate || !toRate) return null;

  const inBase = amount / fromRate;
  return inBase * toRate;
}
