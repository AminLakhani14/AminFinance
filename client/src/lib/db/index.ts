/**
 * Local persistence (IndexedDB via Dexie).
 *
 * This is the system of record for your portfolio — the server never stores
 * it. Transactions are the only durable truth; holdings, P/L, and every
 * analytic are derived from them at read time by selectors.
 *
 * localStorage was rejected here: 5MB cap, synchronous, and it blocks the main
 * thread — years of trade history and daily snapshots would stutter the UI.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { Transaction, PortfolioSnapshot } from '@aminfinance/shared';

/** A daily portfolio valuation, keyed by its normalized timestamp. */
export interface StoredSnapshot extends PortfolioSnapshot {
  id: number;
}

const db = new Dexie('aminfinance') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>;
  snapshots: EntityTable<StoredSnapshot, 'id'>;
};

db.version(1).stores({
  // `externalId` is indexed so a Binance re-sync can dedup fills in one query
  // instead of scanning the whole table.
  transactions: 'id, symbol, assetClass, timestamp, source, externalId',
  snapshots: 'id, timestamp',
});

export { db };

/** All transactions, oldest first — the order cost-basis math requires. */
export async function getAllTransactions(): Promise<Transaction[]> {
  return db.transactions.orderBy('timestamp').toArray();
}

export async function addTransaction(tx: Transaction): Promise<void> {
  await db.transactions.add(tx);
}

export async function updateTransaction(
  id: string,
  changes: Partial<Transaction>,
): Promise<void> {
  await db.transactions.update(id, changes);
}

export async function deleteTransaction(id: string): Promise<void> {
  await db.transactions.delete(id);
}

/**
 * Insert Binance fills, skipping any already stored.
 *
 * Re-syncing overlapping windows is normal (we refetch a trailing period each
 * time), so this must be idempotent or every sync would double your position.
 * Returns the number actually written.
 */
export async function importTransactions(incoming: Transaction[]): Promise<number> {
  if (incoming.length === 0) return 0;

  const externalIds = incoming
    .map((t) => t.externalId)
    .filter((id): id is string => typeof id === 'string');

  const existing = new Set(
    externalIds.length > 0
      ? (await db.transactions.where('externalId').anyOf(externalIds).toArray()).map(
          (t) => t.externalId,
        )
      : [],
  );

  const fresh = incoming.filter(
    (t) => t.externalId === undefined || !existing.has(t.externalId),
  );

  if (fresh.length > 0) await db.transactions.bulkAdd(fresh);
  return fresh.length;
}

/** Upsert a day's valuation. Same-day recomputes overwrite rather than append. */
export async function putSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  await db.snapshots.put({ ...snapshot, id: snapshot.timestamp });
}

export async function getSnapshots(): Promise<StoredSnapshot[]> {
  return db.snapshots.orderBy('timestamp').toArray();
}

/** Wipe everything local. Used by Settings → Reset. */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.transactions, db.snapshots, async () => {
    await db.transactions.clear();
    await db.snapshots.clear();
  });
}
