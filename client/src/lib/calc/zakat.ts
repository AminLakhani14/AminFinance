/**
 * Zakat assessment over the whole book.
 *
 * Zakat is 2.5% of net zakatable wealth held for one lunar year, owed only
 * when that wealth exceeds *nisab* — a threshold defined not in currency but
 * in metal: 87.48g of gold or 612.36g of silver. That definition is why this
 * calculation belongs in an app that already prices metals, and why it cannot
 * be a static number: the threshold moves every day the silver price moves.
 *
 * Two things this file refuses to do:
 *
 * 1. **Pick a fiqh position.** The nisab basis and the treatment of listed
 *    equities are both settings. Silver nisab is roughly a sixth of gold at
 *    modern prices, so the choice decides *whether zakat is owed at all* — a
 *    default that silently picked one would be making a religious ruling on
 *    the user's behalf.
 *
 * 2. **Silently drop what it cannot value.** An unpriced holding or a cash
 *    balance in a currency with no FX rate goes into `excluded`, not into the
 *    total as a zero. Understating an obligation is the one failure mode that
 *    matters here, and it is invisible unless the omission is reported.
 *
 * Every figure is derived at read time. A stored zakat liability outlives the
 * metal price it was measured against.
 */
import type {
  CashAccount,
  Holding,
  Liability,
  NisabBasis,
  ZakatAssessment,
  ZakatLine,
  ZakatSettings,
} from '@aminfinance/shared';
import { GRAMS_PER_TROY_OZ } from '../units';

/**
 * Nisab in grams of fine metal.
 *
 * The classical weights: 20 mithqal of gold and 200 dirham of silver. The
 * gram equivalents below are the figures in common use by contemporary zakat
 * authorities. They are exact constants of the ruling, not measurements, so
 * they are not configurable.
 */
export const NISAB_GRAMS: Record<NisabBasis, number> = {
  gold: 87.48,
  silver: 612.36,
};

/** Spot symbols this app prices, per basis. Troy-ounce quoted. */
const NISAB_SYMBOL: Record<NisabBasis, string> = {
  gold: 'XAUUSD',
  silver: 'XAGUSD',
};

export const DEFAULT_ZAKAT_SETTINGS: ZakatSettings = {
  // Silver: the lower threshold, so more wealth qualifies. The commonly
  // recommended basis for mixed-asset wealth and the cautious choice, but the
  // user can switch it.
  nisabBasis: 'silver',
  // Full market value: the simpler and most widely applied treatment for
  // shares held as an investment.
  equityTreatment: 'market-value',
  equityZakatablePercent: 25,
  ratePercent: 2.5,
  anniversary: null,
};

/** A metal spot price, as the caller has it: per troy ounce, in `currency`. */
export interface MetalSpot {
  symbol: string;
  pricePerTroyOz: number;
  currency: string;
}

export interface ZakatInput {
  holdings: Holding[];
  cash: CashAccount[];
  liabilities: Liability[];
  settings: ZakatSettings;
  /** Spot quotes for gold and silver, used only for the nisab threshold. */
  metals: MetalSpot[];
  /** Convert into the display currency, as `usePortfolio` provides it. */
  convert: (amount: number, currency: string) => number;
  /**
   * True when `convert` has live FX. Without it, cross-currency amounts pass
   * through 1:1, which for a PKR book holding USDT is wrong by ~280x — so the
   * assessment reports those balances as excluded rather than mis-valued.
   */
  fxReady: boolean;
  currency: string;
  now?: number;
}

/**
 * Nisab in the display currency.
 *
 * Returns null rather than a fallback when the metal cannot be priced.
 * Guessing a threshold would produce a `due` flag with no basis, and `due` is
 * the field the user acts on.
 */
function nisabValue(
  basis: NisabBasis,
  metals: MetalSpot[],
  convert: ZakatInput['convert'],
): { nisab: number | null; perGram: number | null } {
  const wanted = NISAB_SYMBOL[basis];
  const spot = metals.find((m) => m.symbol.toUpperCase() === wanted);
  if (!spot || !Number.isFinite(spot.pricePerTroyOz) || spot.pricePerTroyOz <= 0) {
    return { nisab: null, perGram: null };
  }

  // Metals are quoted per troy ounce; nisab is defined per gram. The
  // conversion uses the exact constant from units.ts rather than a rounded
  // 31.1, because the threshold is a yes/no boundary and a book sitting near
  // it should not flip on a rounding error.
  const perGramInQuoteCurrency = spot.pricePerTroyOz / GRAMS_PER_TROY_OZ;
  const perGram = convert(perGramInQuoteCurrency, spot.currency);
  return { nisab: perGram * NISAB_GRAMS[basis], perGram };
}

export function assessZakat(input: ZakatInput): ZakatAssessment {
  const {
    holdings,
    cash,
    liabilities,
    settings,
    metals,
    convert,
    fxReady,
    currency,
    now = Date.now(),
  } = input;

  const lines: ZakatLine[] = [];
  const excluded: Array<{ label: string; reason: string }> = [];

  /**
   * Whether an amount in `from` can be trusted in the display currency.
   * Same-currency amounts always can; anything else needs live FX.
   */
  const convertible = (from: string): boolean =>
    fxReady || from.toUpperCase() === currency.toUpperCase();

  /* ---- Investments -------------------------------------------------- */

  const equityTreatmentNote =
    settings.equityTreatment === 'market-value'
      ? 'Full market value (investment shares)'
      : `${settings.equityZakatablePercent}% of market value (zakatable portion)`;

  let equityTotal = 0;
  let cryptoTotal = 0;
  let metalTotal = 0;

  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;

    // An unpriced holding has marketValue 0, which would quietly shrink the
    // base. It is reported instead.
    if (!Number.isFinite(holding.marketValue) || holding.currentPrice <= 0) {
      excluded.push({
        label: holding.symbol,
        reason: 'No live price — value unknown, so it is not counted.',
      });
      continue;
    }

    if (!convertible(holding.currency)) {
      excluded.push({
        label: holding.symbol,
        reason: `Priced in ${holding.currency} and no FX rate is available.`,
      });
      continue;
    }

    const value = convert(holding.marketValue, holding.currency);

    if (holding.assetClass === 'stock') {
      equityTotal +=
        settings.equityTreatment === 'market-value'
          ? value
          : value * (settings.equityZakatablePercent / 100);
    } else if (holding.assetClass === 'commodity') {
      // Gold and silver are zakatable by weight at full value regardless of
      // the equity treatment — they are the metal the threshold is defined
      // in, not a share in a business.
      metalTotal += value;
    } else {
      cryptoTotal += value;
    }
  }

  if (equityTotal > 0) {
    lines.push({
      label: 'Listed shares',
      amount: equityTotal,
      note: equityTreatmentNote,
    });
  }
  if (cryptoTotal > 0) {
    lines.push({
      label: 'Crypto',
      amount: cryptoTotal,
      note: 'Counted at full market value, like any tradeable asset.',
    });
  }
  if (metalTotal > 0) {
    lines.push({
      label: 'Gold & silver',
      amount: metalTotal,
      note: 'Zakatable by weight at full value.',
    });
  }

  /* ---- Cash --------------------------------------------------------- */

  let cashTotal = 0;
  for (const account of cash) {
    if (account.excludeFromZakat) {
      excluded.push({
        label: account.label,
        reason: 'Marked as not owned by you (held on behalf of someone else).',
      });
      continue;
    }
    if (!Number.isFinite(account.balance) || account.balance === 0) continue;
    if (!convertible(account.currency)) {
      excluded.push({
        label: account.label,
        reason: `Held in ${account.currency} and no FX rate is available.`,
      });
      continue;
    }
    cashTotal += convert(account.balance, account.currency);
  }

  if (cashTotal !== 0) {
    lines.push({
      label: 'Cash & bank',
      amount: cashTotal,
      note: 'Fully zakatable.',
    });
  }

  /* ---- Deductions --------------------------------------------------- */

  let debtTotal = 0;
  for (const liability of liabilities) {
    if (!liability.deductibleFromZakat) continue;
    if (!Number.isFinite(liability.balance) || liability.balance <= 0) continue;
    if (!convertible(liability.currency)) {
      excluded.push({
        label: liability.label,
        reason: `Owed in ${liability.currency} and no FX rate is available.`,
      });
      continue;
    }
    debtTotal += convert(liability.balance, liability.currency);
  }

  if (debtTotal > 0) {
    lines.push({
      label: 'Less: deductible debts',
      amount: -debtTotal,
      note: 'Short-term debts reduce the zakat base.',
    });
  }

  /* ---- Threshold and liability -------------------------------------- */

  const gross = equityTotal + cryptoTotal + metalTotal + cashTotal;
  // Clamped at zero: debts exceeding assets means no zakatable wealth, not a
  // negative one that would invert the comparison against nisab.
  const netWealth = Math.max(0, gross - debtTotal);

  const { nisab, perGram } = nisabValue(settings.nisabBasis, metals, convert);

  // Unknown threshold means unknown obligation. `due: false` here means "not
  // established", and the UI must say so rather than printing "nothing owed".
  const due = nisab !== null && netWealth >= nisab;
  const amount = due ? netWealth * (settings.ratePercent / 100) : 0;

  return {
    netWealth,
    nisab: nisab ?? 0,
    nisabGrams: NISAB_GRAMS[settings.nisabBasis],
    nisabPricePerGram: perGram,
    basis: settings.nisabBasis,
    due,
    amount,
    ratePercent: settings.ratePercent,
    lines,
    currency,
    excluded,
    asOf: now,
  };
}

/**
 * Days until the next zakat anniversary, or null when none is set.
 *
 * Deliberately Gregorian arithmetic over a stored `MM-DD`: the user records
 * the date their lunar year turns, and this only counts down to it. Computing
 * a Hijri date here would need a calendar library and a moon-sighting
 * convention, and a subtly wrong one would shift someone's obligation.
 */
export function daysUntilAnniversary(
  anniversary: string | null,
  now = Date.now(),
): number | null {
  if (!anniversary) return null;
  const parts = anniversary.split('-');
  const month = Number(parts[0]);
  const day = Number(parts[1]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const today = new Date(now);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next.getTime() < todayMidnight.getTime()) {
    next = new Date(today.getFullYear() + 1, month - 1, day);
  }

  return Math.round((next.getTime() - todayMidnight.getTime()) / 86_400_000);
}
