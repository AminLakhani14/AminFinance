/**
 * Issuer logos for PSX equities, fetched for the rows actually on screen.
 *
 * PSX publishes no logos, but every company page lists the issuer's own
 * website, and a domain is enough to fetch a favicon. That is derived
 * server-side; this hook's job is only to ask for it without asking 500 times.
 *
 * The market listing arrives as one bulk scrape with no websites in it, so the
 * logos have to be looked up separately. Asking per row would be hundreds of
 * requests, and asking for everything up front would be hundreds of company
 * pages — so the table asks for the symbols it is rendering, in one batch, and
 * symbols already answered are never asked about again.
 */
import { useEffect, useRef, useState } from 'react';
import { useLazyGetLogosQuery } from '@/services/endpoints';

/** Matches the server's per-request cap. */
const BATCH_LIMIT = 50;

/**
 * Resolved logo URLs by symbol.
 *
 * A symbol maps to null once it is known to have no logo, which is why the
 * cache holds nulls rather than dropping them: without that, every render
 * would re-request the issuers that will never have one.
 */
export function useIssuerLogos(symbols: string[]): Map<string, string | null> {
  const [fetchLogos] = useLazyGetLogosQuery();
  const [resolved, setResolved] = useState<Map<string, string | null>>(new Map());

  // Symbols already requested, whatever the outcome. A ref rather than state:
  // it must not trigger a render, and it has to be readable synchronously
  // inside the effect to keep two overlapping runs from asking twice.
  const requested = useRef<Set<string>>(new Set());

  // Joined rather than passed by identity — the caller rebuilds this array on
  // every render, and depending on the array itself would re-run the effect
  // each time even when the symbols are unchanged.
  const key = symbols.join(',');

  useEffect(() => {
    const pending = symbols.filter((s) => s && !requested.current.has(s)).slice(0, BATCH_LIMIT);
    if (pending.length === 0) return;

    // Marked before the request, not after: the effect can run again while
    // this one is still in flight, and the second run must not re-ask.
    for (const symbol of pending) requested.current.add(symbol);

    let cancelled = false;
    void (async () => {
      try {
        const { logos } = await fetchLogos(pending).unwrap();
        if (cancelled) return;
        setResolved((current) => {
          const next = new Map(current);
          for (const symbol of pending) next.set(symbol, logos[symbol] ?? null);
          return next;
        });
      } catch {
        // A failed lookup leaves these symbols marked as requested, so the
        // table settles on monograms instead of retrying on every scroll.
        if (cancelled) return;
        setResolved((current) => {
          const next = new Map(current);
          for (const symbol of pending) if (!next.has(symbol)) next.set(symbol, null);
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `symbols` is intentionally read through the joined key; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchLogos]);

  return resolved;
}
