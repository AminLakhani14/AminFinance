/**
 * Live zakat assessment.
 *
 * Fetches gold and silver spot independently of the user's holdings: nisab is
 * defined as a weight of metal, so the threshold must be priced whether or
 * not the user owns any. That is the whole reason this hook exists rather
 * than reading the portfolio's existing quote map — a book of PSX equities
 * has no metal quote in it, and the threshold is exactly what decides whether
 * zakat is owed.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ZakatAssessment } from '@aminfinance/shared';
import { db } from '@/lib/db';
import { useAppSelector } from '@/app/hooks';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useGetQuotesQuery } from '@/services/endpoints';
import { assessZakat, daysUntilAnniversary, type MetalSpot } from '@/lib/calc/zakat';

/** Both metals, so switching the basis in Settings needs no refetch. */
const NISAB_SYMBOLS = ['XAUUSD', 'XAGUSD'];

export interface ZakatState {
  assessment: ZakatAssessment | null;
  /** Days to the user's zakat anniversary, or null when unset. */
  daysToAnniversary: number | null;
  /** Metal spot could not be fetched, so the threshold is unknown. */
  nisabUnavailable: boolean;
  isLoading: boolean;
  currency: string;
}

export function useZakat(): ZakatState {
  const zakatSettings = useAppSelector((s) => s.settings.zakat);
  const { holdings, convert, displayCurrency, isLoading: portfolioLoading } = usePortfolio();

  const accounts = useLiveQuery(() => db.cash.toArray(), []);
  const liabilities = useLiveQuery(() => db.liabilities.toArray(), []);

  // Metals move slowly and the threshold is a daily question, so this polls
  // far less often than a position quote would.
  const metalsQuery = useGetQuotesQuery(NISAB_SYMBOLS, {
    pollingInterval: 15 * 60_000,
    skipPollingIfUnfocused: true,
  });

  const fxReady = useMemo(() => {
    // Same-currency books need no FX. A PKR book holding USDT does, and
    // without it the assessment reports those rows as excluded rather than
    // converting 1:1 and understating the base by two orders of magnitude.
    const needsFx = holdings.some(
      (h) => h.currency.toUpperCase() !== displayCurrency.toUpperCase(),
    );
    if (!needsFx) return true;
    // `convert` falls back to identity without rates, so probe it: a non-1:1
    // result on a foreign amount means rates arrived.
    return convert(1, 'USD') !== 1 || displayCurrency.toUpperCase() === 'USD';
  }, [holdings, convert, displayCurrency]);

  const metals = useMemo<MetalSpot[]>(() => {
    const quotes = metalsQuery.data?.quotes ?? [];
    return quotes.map((quote) => ({
      symbol: quote.symbol,
      pricePerTroyOz: quote.price,
      currency: quote.currency,
    }));
  }, [metalsQuery.data]);

  const assessment = useMemo(() => {
    if (accounts === undefined || liabilities === undefined) return null;
    return assessZakat({
      holdings,
      cash: accounts,
      liabilities,
      settings: zakatSettings,
      metals,
      convert,
      fxReady,
      currency: displayCurrency,
    });
  }, [holdings, accounts, liabilities, zakatSettings, metals, convert, fxReady, displayCurrency]);

  return {
    assessment,
    daysToAnniversary: daysUntilAnniversary(zakatSettings.anniversary),
    nisabUnavailable: assessment !== null && assessment.nisabPricePerGram === null,
    isLoading:
      portfolioLoading ||
      accounts === undefined ||
      liabilities === undefined ||
      metalsQuery.isLoading,
    currency: displayCurrency,
  };
}
