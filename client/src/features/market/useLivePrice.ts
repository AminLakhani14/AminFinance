/**
 * React bindings for the price stream.
 *
 * `useSyncExternalStore` rather than state-plus-effect: it subscribes per
 * symbol, so a tick re-renders only the components watching that symbol, and
 * it tears reads correctly under concurrent rendering.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AssetClass } from '@aminfinance/shared';
import {
  retainSymbols,
  subscribeToSymbol,
  subscribeToStatus,
  getTick,
  isConnected,
  type LiveTick,
} from '@/services/priceStream';

/**
 * Keep a set of symbols streaming for as long as the component is mounted.
 *
 * Only crypto is passed upstream — PSX and spot metals have no streaming
 * source, and subscribing to them would have the server open a Binance stream
 * for a ticker Binance has never heard of.
 */
export function useStreamedSymbols(
  assets: Array<{ symbol: string; assetClass: AssetClass }>,
): void {
  // Join into a primitive so the effect is keyed on content, not array
  // identity — a fresh array every render would resubscribe on every render.
  const key = useMemo(
    () =>
      assets
        .filter((a) => a.assetClass === 'crypto')
        .map((a) => a.symbol.toUpperCase())
        .sort()
        .join(','),
    [assets],
  );

  useEffect(() => {
    if (!key) return;
    return retainSymbols(key.split(','));
  }, [key]);
}

/** The latest tick for one symbol, or null if none has arrived yet. */
export function useLiveTick(symbol: string): LiveTick | null {
  const subscribe = useMemo(
    () => (listener: () => void) => subscribeToSymbol(symbol, listener),
    [symbol],
  );
  return useSyncExternalStore(
    subscribe,
    () => getTick(symbol) ?? null,
    () => null, // No stream on the server render.
  );
}

/** Whether the upstream Binance stream is currently connected. */
export function useStreamStatus(): boolean {
  return useSyncExternalStore(subscribeToStatus, isConnected, () => false);
}
