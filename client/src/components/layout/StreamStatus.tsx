/**
 * Live-stream indicator, sat beside the server status.
 *
 * Distinct from `ServerStatus` on purpose: the REST proxy can be perfectly
 * healthy while the Binance socket is down, and on a screen whose whole promise
 * is that the numbers move, "the prices have stopped updating" is exactly the
 * failure a user must be able to see. A frozen tape that looks live is worse
 * than no tape.
 */
import { Radio } from 'lucide-react';
import { useStreamStatus } from '@/features/market/useLivePrice';
import { cn } from '@/lib/utils';

export function StreamStatus() {
  const connected = useStreamStatus();

  return (
    <div
      title={
        connected
          ? 'Crypto prices streaming from Binance'
          : 'Price stream disconnected — crypto values fall back to the last polled quote'
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border',
        'bg-surface px-2.5 py-1 text-xs font-medium',
        connected ? 'text-positive' : 'text-text-subtle',
      )}
    >
      <span className="relative flex size-2">
        {connected ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" />
        ) : null}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            connected ? 'bg-positive' : 'bg-text-subtle',
          )}
        />
      </span>
      <Radio className="size-3.5" />
      <span className="hidden sm:inline">{connected ? 'Live' : 'Idle'}</span>
    </div>
  );
}
