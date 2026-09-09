/**
 * A price that visibly ticks.
 *
 * The flash is the point: on a trading screen, movement is what tells you the
 * data is alive and where attention belongs. Colour marks *direction of the
 * tick* (green up, red down) and is deliberately separate from the P/L colour
 * used elsewhere — a position can be down on the day while its last tick was
 * up, and conflating those would be misleading.
 *
 * Falls back to the polled REST price when no tick has arrived, so PSX rows and
 * a cold stream render identically to before rather than showing a gap.
 */
import { useEffect, useRef, useState } from 'react';
import { useLiveTick } from '@/features/market/useLivePrice';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Long enough to register, short enough not to smear at several ticks/sec. */
const FLASH_MS = 600;

export function LivePrice({
  symbol,
  fallbackPrice,
  currency,
  className,
}: {
  symbol: string;
  fallbackPrice: number;
  currency: string;
  className?: string;
}) {
  const tick = useLiveTick(symbol);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const lastFlashed = useRef<number | null>(null);

  useEffect(() => {
    if (!tick || tick.direction === 'flat') return;
    // Guard on the timestamp: re-renders from a parent must not re-trigger a
    // flash for a tick that has already been shown.
    if (lastFlashed.current === tick.timestamp) return;
    lastFlashed.current = tick.timestamp;

    setFlash(tick.direction);
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [tick]);

  const price = tick?.price ?? fallbackPrice;

  return (
    <span
      className={cn(
        'nums inline-block rounded px-1 transition-colors duration-300',
        flash === 'up' && 'bg-positive/20 text-positive',
        flash === 'down' && 'bg-negative/20 text-negative',
        className,
      )}
      // Screen readers should hear the value, not every flash.
      aria-live="off"
    >
      {formatCurrency(price, currency)}
    </span>
  );
}
