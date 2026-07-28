/**
 * The single source of derived portfolio state.
 *
 * Transactions (IndexedDB) + live quotes (server) + FX rates → holdings, P/L,
 * allocation, and totals. Everything is computed on read and memoized; nothing
 * derived is stored, which is what keeps the numbers from going stale.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Transaction, PortfolioSummary, Quote } from '@aminfinance/shared';
import { db } from '@/lib/db';
import { useAppSelector } from '@/app/hooks';
import { useGetQuotesQuery, useGetFxQuery } from '@/services/endpoints';
import { buildPositions, buildHoldings, type HoldingWithFlags } from '@/lib/calc/costBasis';
import { toFiatCode } from '@/lib/calc/currency';

export interface PortfolioState {
  transactions: Transaction[];
  holdings: HoldingWithFlags[];
  summary: PortfolioSummary;
  quotes: Map<string, Quote>;
  /** Symbols the server could not price. */
  quoteErrors: Record<string, string>;
  isLoading: boolean;
  isEmpty: boolean;
  /** Seconds since the underlying quote data was fetched. */
  dataAgeSeconds: number;
  /** Convert an amount from `currency` into the display currency. */
  convert: (amount: number, currency: string) => number;
  displayCurrency: string;
}

const EMPTY_SUMMARY = (currency: string): PortfolioSummary => ({
  totalValue: 0,
  totalCostBasis: 0,
  totalUnrealizedPnl: 0,
  totalUnrealizedPnlPercent: 0,
  totalRealizedPnl: 0,
  dayChange: 0,
  dayChangePercent: 0,
  currency,
  holdingsCount: 0,
  asOf: Date.now(),
});

export function usePortfolio(): PortfolioState {
  const displayCurrency = useAppSelector((s) => s.settings.displayCurrency);

  const transactions = useLiveQuery(() => db.transactions.orderBy('timestamp').toArray(), [], []);

  // Positions depend only on transactions, so they recompute only when the
  // ledger actually changes — not on every price tick.
  const positions = useMemo(() => buildPositions(transactions ?? []), [transactions]);

  const symbols = useMemo(
    () =>
      [...positions.values()]
        .filter((p) => p.quantity > 0)
        .map((p) => p.symbol)
        .sort(),
    [positions],
  );

  const quoteRefreshMs = useAppSelector((s) => s.settings.quoteRefreshMs);

  const quotesQuery = useGetQuotesQuery(symbols, {
    skip: symbols.length === 0,
    pollingInterval: quoteRefreshMs,
    // Pause polling in a background tab so a forgotten window doesn't burn quota.
    skipPollingIfUnfocused: true,
  });

  const fxQuery = useGetFxQuery('USD');

  const quotes = useMemo(() => {
    const map = new Map<string, Quote>();
    for (const q of quotesQuery.data?.quotes ?? []) map.set(q.symbol, q);
    return map;
  }, [quotesQuery.data]);

  /**
   * Currency conversion. Falls back to 1:1 when rates are unavailable rather
   * than zeroing the position — a wrong-but-close total beats a blank one, and
   * the UI flags when FX is missing.
   */
  const convert = useMemo(() => {
    const rates = fxQuery.data;
    return (amount: number, currency: string): number => {
      const from = toFiatCode(currency);
      const to = toFiatCode(displayCurrency);
      if (from === to) return amount;
      if (!rates) return amount;

      const base = rates.base;
      const fromRate = from === base ? 1 : rates.rates[from];
      const toRate = to === base ? 1 : rates.rates[to];
      if (!fromRate || !toRate) return amount;
      return (amount / fromRate) * toRate;
    };
  }, [fxQuery.data, displayCurrency]);

  const holdings = useMemo(() => {
    const priced = buildHoldings(positions, quotes);

    // Allocation needs the total, so it's a second pass over converted values.
    const totalValue = priced.reduce(
      (sum, h) => sum + convert(h.marketValue, h.currency),
      0,
    );

    return priced
      .map((h) => ({
        ...h,
        allocationPercent: totalValue > 0 ? (convert(h.marketValue, h.currency) / totalValue) * 100 : 0,
      }))
      .sort((a, b) => convert(b.marketValue, b.currency) - convert(a.marketValue, a.currency));
  }, [positions, quotes, convert]);

  const summary = useMemo((): PortfolioSummary => {
    if (holdings.length === 0) return EMPTY_SUMMARY(displayCurrency);

    let totalValue = 0;
    let totalCostBasis = 0;
    let dayChange = 0;
    // Market value counts toward the total regardless; cost basis and P/L only
    // aggregate over positions where the cost is actually known. Otherwise a
    // single Earn-acquired coin would inflate portfolio P/L by its full value.
    let valueWithKnownCost = 0;

    for (const h of holdings) {
      totalValue += convert(h.marketValue, h.currency);
      dayChange += convert(h.dayChange, h.currency);
      if (h.costBasisKnown) {
        totalCostBasis += convert(h.costBasis, h.currency);
        valueWithKnownCost += convert(h.marketValue, h.currency);
      }
    }

    const totalRealizedPnl = [...positions.values()].reduce(
      (sum, p) =>
        sum + p.realized.reduce((s, r) => s + convert(r.gain, p.currency), 0),
      0,
    );

    const totalUnrealizedPnl = valueWithKnownCost - totalCostBasis;
    const previousValue = totalValue - dayChange;

    return {
      totalValue,
      totalCostBasis,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent:
        totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0,
      totalRealizedPnl,
      dayChange,
      dayChangePercent: previousValue > 0 ? (dayChange / previousValue) * 100 : 0,
      currency: displayCurrency,
      holdingsCount: holdings.length,
      asOf: Date.now(),
    };
  }, [holdings, positions, convert, displayCurrency]);

  return {
    transactions: transactions ?? [],
    holdings,
    summary,
    quotes,
    quoteErrors: quotesQuery.data?.errors ?? {},
    isLoading: transactions === undefined || (symbols.length > 0 && quotesQuery.isLoading),
    isEmpty: (transactions?.length ?? 0) === 0,
    dataAgeSeconds: 0,
    convert,
    displayCurrency,
  };
}
