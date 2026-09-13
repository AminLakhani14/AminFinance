/**
 * Bringing the two stores into agreement.
 *
 * Runs on sign-in, and on demand from Settings. The merge is last-write-wins
 * by row id, which is the right rule for one person on several devices: there
 * is no second author to conflict with, only the same person's laptop and
 * phone holding different snapshots of one book.
 *
 * Local rows the cloud has never seen are pushed rather than dropped — the
 * first sync after adding the cloud has to carry an existing local book up,
 * not wipe it.
 */
import { db } from '@/lib/db';
import {
  pullTransactions,
  pullSnapshots,
  pullBudgetEntries,
  pushTransactions,
  pushBudgetEntries,
} from './cloud';
import { supabase } from './client';
import { fromSnapshot } from './types';

export interface SyncResult {
  pulled: { transactions: number; snapshots: number; budget: number };
  pushed: { transactions: number; snapshots: number; budget: number };
}

/**
 * Reconcile local and cloud in both directions.
 *
 * Deliberately not a delta sync. The whole book is a few thousand rows at
 * most, and a full compare on sign-in is both simpler and more robust than
 * tracking change cursors that can be missed while a device is offline.
 */
export async function syncAll(): Promise<SyncResult> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error('Not signed in.');

  const [cloudTxs, cloudSnaps, cloudBudget] = await Promise.all([
    pullTransactions(),
    pullSnapshots(),
    pullBudgetEntries(),
  ]);

  const [localTxs, localSnaps, localBudget] = await Promise.all([
    db.transactions.toArray(),
    db.snapshots.toArray(),
    db.budget.toArray(),
  ]);

  const cloudTxIds = new Set(cloudTxs.map((t) => t.id));
  const cloudBudgetIds = new Set(cloudBudget.map((e) => e.id));
  const cloudSnapTimes = new Set(cloudSnaps.map((s) => s.timestamp));

  // Local-only rows predate the cloud (or were written offline) and are the
  // user's real data — they go up.
  const txsToPush = localTxs.filter((t) => !cloudTxIds.has(t.id));
  const budgetToPush = localBudget.filter((e) => !cloudBudgetIds.has(e.id));
  const snapsToPush = localSnaps.filter((s) => !cloudSnapTimes.has(s.timestamp));

  await Promise.all([
    pushTransactions(txsToPush),
    pushBudgetEntries(budgetToPush),
    snapsToPush.length > 0
      ? supabase.from('snapshots').upsert(snapsToPush.map((s) => fromSnapshot(s, userId)))
      : Promise.resolve(),
  ]);

  // `bulkPut`, not `bulkAdd`: a row present in both stores must be overwritten
  // by the cloud copy, and `bulkAdd` would throw on the existing key instead.
  await db.transaction('rw', db.transactions, db.snapshots, db.budget, async () => {
    if (cloudTxs.length > 0) await db.transactions.bulkPut(cloudTxs);
    if (cloudSnaps.length > 0) await db.snapshots.bulkPut(cloudSnaps);
    if (cloudBudget.length > 0) await db.budget.bulkPut(cloudBudget);
  });

  return {
    pulled: {
      transactions: cloudTxs.length,
      snapshots: cloudSnaps.length,
      budget: cloudBudget.length,
    },
    pushed: {
      transactions: txsToPush.length,
      snapshots: snapsToPush.length,
      budget: budgetToPush.length,
    },
  };
}

/**
 * Push the entire local book upward, overwriting the cloud copy.
 *
 * The escape hatch for when the two have diverged badly enough that
 * last-write-wins would keep the wrong rows — the user declares this device
 * authoritative and the cloud takes its contents wholesale.
 */
export async function pushEverything(): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const [txs, snaps, budget] = await Promise.all([
    db.transactions.toArray(),
    db.snapshots.toArray(),
    db.budget.toArray(),
  ]);

  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error('Not signed in.');

  await pushTransactions(txs);
  await pushBudgetEntries(budget);
  if (snaps.length > 0) {
    const { error } = await supabase
      .from('snapshots')
      .upsert(snaps.map((s) => fromSnapshot(s, userId)));
    if (error) throw error;
  }
}
