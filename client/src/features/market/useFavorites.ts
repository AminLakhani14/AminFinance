import { useCallback, useState } from 'react';
import type { AssetRef } from '@aminfinance/shared';

const STORAGE_KEY = 'aminfinance.market-favorites.v1';

export function favoriteKey(asset: AssetRef): string {
  return `${asset.assetClass}:${asset.symbol.toUpperCase()}`;
}

/** Small local preference; unlike portfolio transactions this needs no database. */
export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites);

  const toggleFavorite = useCallback((asset: AssetRef) => {
    setFavorites((current) => {
      const next = new Set(current);
      const key = favoriteKey(asset);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistFavorites(next);
      return next;
    });
  }, []);

  return { favorites, toggleFavorite };
}

function readFavorites(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(stored)
        ? stored.filter((item): item is string => typeof item === 'string' && item.includes(':'))
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistFavorites(favorites: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites].sort()));
  } catch {
    // Storage can be unavailable in private mode; favorites remain session-local.
  }
}
