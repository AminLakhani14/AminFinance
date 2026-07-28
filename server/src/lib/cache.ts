/**
 * Two-tier cache: in-memory TTL + disk snapshot for the long-lived entries.
 *
 * The disk tier is not a database — it is a JSON file whose only purpose is
 * surviving a restart so the 24h entries (fundamentals, dividends, AI
 * insights) don't get refetched on every `tsx watch` reload. Deleting it costs
 * a day of freshness and nothing else.
 *
 * Also holds the last-good value for every key, which is what lets a route
 * serve stale-but-real data with `X-Stale: true` when an upstream is down —
 * strictly better than an error page for a portfolio you just want to glance at.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, '../../.cache');
const CACHE_FILE = resolve(CACHE_DIR, 'snapshot.json');

interface Entry<T = unknown> {
  value: T;
  /** Epoch ms when fetched. */
  storedAt: number;
  /** Milliseconds this entry stays fresh. */
  ttlMs: number;
  /** Whether to persist across restarts. */
  persist: boolean;
}

const store = new Map<string, Entry>();

/** Debounced disk write — bursty cache fills shouldn't cause a write per key. */
let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDisk();
  }, 2_000);
  flushTimer.unref?.();
}

function flushToDisk(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const persisted: Record<string, Entry> = {};
    for (const [key, entry] of store) {
      if (entry.persist) persisted[key] = entry;
    }
    writeFileSync(CACHE_FILE, JSON.stringify(persisted), 'utf8');
  } catch {
    // A cache that can't persist still works in memory. Never fatal.
  }
}

function loadFromDisk(): void {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, Entry>;
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.storedAt === 'number') store.set(key, entry);
    }
  } catch {
    // Corrupt snapshot — start cold rather than crash on boot.
  }
}

loadFromDisk();

export interface CacheLookup<T> {
  value: T;
  ageSeconds: number;
  /** True when the entry is past its TTL (caller decided to use it anyway). */
  stale: boolean;
}

/** Fresh entry only, or null. */
export function get<T>(key: string): CacheLookup<T> | null {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return null;
  const age = Date.now() - entry.storedAt;
  if (age > entry.ttlMs) return null;
  return { value: entry.value, ageSeconds: Math.round(age / 1000), stale: false };
}

/**
 * Any entry regardless of age — the fallback when an upstream fails and a
 * stale answer beats no answer.
 */
export function getStale<T>(key: string): CacheLookup<T> | null {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return null;
  const age = Date.now() - entry.storedAt;
  return {
    value: entry.value,
    ageSeconds: Math.round(age / 1000),
    stale: age > entry.ttlMs,
  };
}

export function set<T>(key: string, value: T, ttlMs: number, persist = false): void {
  store.set(key, { value, storedAt: Date.now(), ttlMs, persist });
  if (persist) scheduleFlush();
}

/**
 * Fetch-through helper with stale-on-error.
 *
 * Order: fresh cache -> upstream -> stale cache. The last step is what keeps
 * the dashboard usable when PSX DPS is down or rate-limiting us.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options: { persist?: boolean } = {},
): Promise<CacheLookup<T> & { hit: boolean }> {
  const fresh = get<T>(key);
  if (fresh) return { ...fresh, hit: true };

  try {
    const value = await loader();
    set(key, value, ttlMs, options.persist ?? false);
    return { value, ageSeconds: 0, stale: false, hit: false };
  } catch (err) {
    const stale = getStale<T>(key);
    if (stale) return { ...stale, stale: true, hit: true };
    throw err;
  }
}

/** Test/ops helper. */
export function clear(): void {
  store.clear();
  flushToDisk();
}

export function stats(): { entries: number; persisted: number } {
  let persisted = 0;
  for (const entry of store.values()) if (entry.persist) persisted++;
  return { entries: store.size, persisted };
}

/** TTLs in one place so the refresh strategy is auditable. */
export const TTL = {
  quote: 60_000,
  candles: 5 * 60_000,
  fundamentals: 24 * 60 * 60_000,
  dividends: 24 * 60 * 60_000,
  news: 60 * 60_000,
  fx: 12 * 60 * 60_000,
  binanceAccount: 30_000,
  binanceTrades: 5 * 60_000,
  aiInsight: 24 * 60 * 60_000,
} as const;
