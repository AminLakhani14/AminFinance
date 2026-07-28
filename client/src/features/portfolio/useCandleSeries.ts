/**
 * Daily candle series for up to eight holdings.
 *
 * The query count is fixed and padded with skipped slots, so hook order stays
 * stable across renders even as the holdings list changes — that is what makes
 * calling hooks in a `.map` safe here.
 *
 * Eight matches the chart palette's series cap: beyond that, colours would have
 * to repeat, and a repeated colour means two different things on one chart.
 */
import { useMemo } from 'react';
import type { Candle } from '@aminfinance/shared';
import { marketApi } from '@/services/endpoints';

export const MAX_TRACKED = 8;

export function useCandleSeries(
  symbols: string[],
  limit = 180,
): Map<string, Candle[]> {
  const padded = [...symbols.slice(0, MAX_TRACKED)];
  while (padded.length < MAX_TRACKED) padded.push('');

  const queries = padded.map((symbol) =>
    // Safe: `padded` is always MAX_TRACKED long, so the hook count never varies.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    marketApi.useGetCandlesQuery({ symbol, interval: '1d', limit }, { skip: !symbol }),
  );

  const map = new Map<string, Candle[]>();
  padded.forEach((symbol, i) => {
    const data = queries[i]?.data;
    if (symbol && data && data.candles.length > 0) map.set(symbol, data.candles);
  });
  return map;
}

/** Closing prices only, for sparklines. */
export function useSparklines(symbols: string[], points = 30): Map<string, number[]> {
  const series = useCandleSeries(symbols, points);
  return useMemo(() => {
    const map = new Map<string, number[]>();
    for (const [symbol, candles] of series) {
      map.set(symbol, candles.slice(-points).map((c) => c.close));
    }
    return map;
    // `series` is rebuilt each render by design; key on its content instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [[...series.keys()].join(','), [...series.values()].map((v) => v.length).join(','), points]);
}
