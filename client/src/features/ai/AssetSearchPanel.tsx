/**
 * Ask the AI about any one instrument, held or not.
 *
 * The ranked sections answer "where should the next rupee go, out of these?".
 * This answers "what about that one?" for something not in the list at all —
 * a name the user heard about, or one the candidate scan never surfaced.
 *
 * The symbol is resolved before it is analysed. A typo would otherwise reach
 * the model as a real ticker and come back with a confident analysis of
 * nothing, which is the worst available outcome; `/api/search` settles whether
 * the instrument exists and which class it belongs to, so the analysis is
 * always of something real.
 */
import { useState, type FormEvent } from 'react';
import { Search, Loader2, X } from 'lucide-react';
import type { AssetClass } from '@aminfinance/shared';
import { Button } from '@/components/ui/Button';
import { AssetInsightCard } from '@/features/ai/AssetInsightCard';
import { useLazySearchSymbolQuery } from '@/services/endpoints';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { cn } from '@/lib/utils';

interface Resolved {
  symbol: string;
  assetClass: AssetClass;
}

export function AssetSearchPanel() {
  const [query, setQuery] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [search, { isFetching }] = useLazySearchSymbolQuery();
  const { holdings } = usePortfolio();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim().toUpperCase();
    if (!needle) return;

    setNotFound(null);
    try {
      const { results } = await search(needle).unwrap();
      // Prefer an exact ticker match over the first prefix hit: searching
      // "BTC" should analyse BTCUSDT rather than whichever pair sorts first,
      // but searching "OGDC" must never resolve to some other issuer.
      const exact = results.find((r) => r.symbol === needle);
      const hit = exact ?? results[0];
      if (!hit) {
        setNotFound(needle);
        setResolved(null);
        return;
      }
      setResolved({ symbol: hit.symbol, assetClass: hit.assetClass });
    } catch {
      setNotFound(needle);
      setResolved(null);
    }
  }

  function clear() {
    setResolved(null);
    setNotFound(null);
    setQuery('');
  }

  // Analysing something already owned should reason about the actual position
  // — cost basis and size change the answer — rather than treating it as a
  // fresh entry.
  const position = resolved
    ? holdings.find((h) => h.symbol.toUpperCase() === resolved.symbol.toUpperCase())
    : undefined;

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask about any symbol — OGDC, BTCUSDT, XAUUSD…"
            aria-label="Symbol to analyse"
            className={cn(
              'h-9 w-full rounded-lg border border-border bg-surface-sunken pl-9 pr-3',
              'text-sm text-text placeholder:text-text-subtle',
              'focus:border-border-strong focus:outline-none',
            )}
          />
        </div>
        <Button type="submit" variant="secondary" size="md" disabled={isFetching || !query.trim()}>
          {isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Analyse
        </Button>
        {resolved || notFound ? (
          <Button type="button" variant="ghost" size="md" onClick={clear}>
            <X className="size-4" />
            Clear
          </Button>
        ) : null}
      </form>

      {notFound ? (
        <p className="text-sm text-text-muted">
          No instrument found for{' '}
          <span className="font-medium text-text">{notFound}</span>. PSX tickers are unsuffixed
          (OGDC), Binance pairs carry their quote (BTCUSDT), and metals use their spot code
          (XAUUSD).
        </p>
      ) : null}

      {resolved ? (
        <AssetInsightCard
          // Keyed on the symbol so switching to a different one mounts a fresh
          // card rather than leaving the previous analysis on screen under a
          // new heading.
          key={`${resolved.assetClass}:${resolved.symbol}`}
          symbol={resolved.symbol}
          assetClass={resolved.assetClass}
          {...(position
            ? { position: { quantity: position.quantity, averageCost: position.averageCost } }
            : {})}
        />
      ) : null}
    </div>
  );
}
