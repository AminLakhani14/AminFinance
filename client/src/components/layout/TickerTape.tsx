/**
 * Scrolling ticker across the top of the app.
 *
 * Content is duplicated once and the track translated by exactly -50%, which
 * makes the loop seamless without measuring anything: at the halfway point the
 * second copy sits precisely where the first began.
 *
 * Honours prefers-reduced-motion by not scrolling at all — a permanently
 * moving strip is a genuine accessibility problem, and the prices are still
 * legible and still live when it holds still.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useStreamedSymbols, useLiveTick } from '@/features/market/useLivePrice';
import { cn } from '@/lib/utils';

export function TickerTape() {
  const { holdings, isEmpty } = usePortfolio();
  const reduceMotion = useReducedMotion();

  const assets = useMemo(
    () => holdings.map((h) => ({ symbol: h.symbol, assetClass: h.assetClass })),
    [holdings],
  );
  useStreamedSymbols(assets);

  if (isEmpty || holdings.length === 0) return null;

  const items = holdings.map((h) => (
    <TickerItem
      key={h.symbol}
      symbol={h.symbol}
      fallbackPrice={h.currentPrice}
      fallbackChange={h.dayChangePercent}
    />
  ));

  return (
    <div className="relative overflow-hidden border-b border-border bg-surface-sunken">
      <div
        className={cn(
          'flex w-max items-center gap-6 py-1.5',
          !reduceMotion && 'animate-ticker',
        )}
      >
        {items}
        {/* Duplicate for the seamless wrap. Hidden from assistive tech so the
            same prices are not announced twice. */}
        <div className="flex items-center gap-6" aria-hidden>
          {items}
        </div>
      </div>
    </div>
  );
}

function TickerItem({
  symbol,
  fallbackPrice,
  fallbackChange,
}: {
  symbol: string;
  fallbackPrice: number;
  fallbackChange: number;
}) {
  const tick = useLiveTick(symbol);
  const price = tick?.price ?? fallbackPrice;
  const change = tick?.changePercent ?? fallbackChange;
  const up = change >= 0;

  return (
    <Link
      to={`/asset/${encodeURIComponent(symbol)}`}
      className="flex shrink-0 items-baseline gap-1.5 px-1 text-xs hover:opacity-80"
    >
      <span className="font-medium text-text-muted">{symbol}</span>
      <span className="nums text-text">
        {price.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </span>
      <span className={cn('nums', up ? 'text-positive' : 'text-negative')}>
        {up ? '▲' : '▼'}
        {Math.abs(change).toFixed(2)}%
      </span>
    </Link>
  );
}
