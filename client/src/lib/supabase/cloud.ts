/**
 * The cloud half of persistence.
 *
 * Dexie stays the read path — `useLiveQuery` drives every view, and routing
 * reads through Postgres would trade instant local renders for a network
 * round trip on each one. This module is the write mirror and the puller:
 * local writes are echoed up, and a sign-in brings the cloud back down.
 *
 * Every function here is a no-op when the user is signed out, so the app runs
 * unchanged on local-only storage. That is what keeps cloud sync an addition
 * rather than a dependency — the failure mode of an expired token or a dead
 * network is a stale backup, never a blocked write.
 */
import type { Transaction, PortfolioSnapshot, BudgetEntry } from '@aminfinance/shared';
import { supabase } from './client';
import {
  fromTransaction,
  fromSnapshot,
  fromBudgetEntry,
  toTransaction,
  toSnapshot,
  toBudgetEntry,
  type TransactionRow,
  type SnapshotRow,
  type BudgetRow,
} from './types';

/** Postgres refuses inserts past ~65k parameters; 500 rows stays well clear. */
const CHUNK = 500;

/**
 * The signed-in user's id, or null when signed out.
 *
 * Read from the in-memory session rather than `getUser()`, which makes a
 * network call — a mirrored write must not wait on one before touching the
 * local database.
 */
async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

async function* chunked<T>(rows: T[]) {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}

// ------------------------------------------------------------------- push
//
// All upserts, never inserts. A mirror that failed mid-write and retried
// would hit duplicate keys on insert; upsert makes every push idempotent, so
// a retry costs nothing and a partial failure heals on the next one.

export async function pushTransactions(txs: Transaction[]): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !supabase || txs.length === 0) return;

  for await (const batch of chunked(txs.map((t) => fromTransaction(t, userId)))) {
    const { error } = await supabase.from('transactions').upsert(batch);
    if (error) throw error;
  }
}

export async function deleteTransactionsRemote(ids: string[]): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !supabase || ids.length === 0) return;

  for await (const batch of chunked(ids)) {
    const { error } = await supabase.from('transactions').delete().in('id', batch);
    if (error) throw error;
  }
}

export async function pushSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !supabase) return;

  const { error } = await supabase
    .from('snapshots')
    .upsert(fromSnapshot(snapshot, userId));
  if (error) throw error;
}

export async function pushBudgetEntries(entries: BudgetEntry[]): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !supabase || entries.length === 0) return;

  for await (const batch of chunked(entries.map((e) => fromBudgetEntry(e, userId)))) {
    const { error } = await supabase.from('budget').upsert(batch);
    if (error) throw error;
  }
}

export async function deleteBudgetEntriesRemote(ids: string[]): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !supabase || ids.length === 0) return;

  for await (const batch of chunked(ids)) {
    const { error } = await supabase.from('budget').delete().in('id', batch);
    if (error) throw error;
  }
}

// ------------------------------------------------------------------- pull
//
// Paged explicitly. PostgREST caps a response at 1000 rows by default and
// returns the first page without complaint, so an unpaged read looks like a
// success while silently truncating years of history.

const PAGE = 1000;

async function fetchAll<Row>(table: 'transactions' | 'snapshots' | 'budget'): Promise<Row[]> {
  if (!supabase) return [];

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('timestamp', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export async function pullTransactions(): Promise<Transaction[]> {
  return (await fetchAll<TransactionRow>('transactions')).map(toTransaction);
}

export async function pullSnapshots(): Promise<Array<PortfolioSnapshot & { id: number }>> {
  return (await fetchAll<SnapshotRow>('snapshots')).map(toSnapshot);
}

export async function pullBudgetEntries(): Promise<BudgetEntry[]> {
  return (await fetchAll<BudgetRow>('budget')).map(toBudgetEntry);
}
