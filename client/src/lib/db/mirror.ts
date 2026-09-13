/**
 * Fire-and-forget echo of local writes to the cloud.
 *
 * Every function here returns void, not a promise, and that is the point: the
 * local write has already committed by the time the mirror is called, and the
 * UI renders from Dexie. Awaiting the network would put a round trip in front
 * of a render that does not depend on it — typing an amount into the budget
 * sheet would stutter on every keystroke.
 *
 * A failed push is therefore not an error the caller can handle; it is a
 * backup that has fallen behind. It is recorded here and resolved by the next
 * `syncAll`, which compares both stores wholesale.
 *
 * Signed out, unconfigured, or offline, all of this is inert — which is what
 * keeps cloud sync an addition to the app rather than a dependency of it.
 */
import type { Transaction, PortfolioSnapshot, BudgetEntry } from '@aminfinance/shared';
import * as cloud from '@/lib/supabase/cloud';

/** Pushes that failed, kept so the UI can show sync as degraded. */
let failures = 0;
let lastError: string | null = null;

export interface MirrorStatus {
  /** Writes that never reached the cloud since the last successful sync. */
  pendingFailures: number;
  lastError: string | null;
}

export function mirrorStatus(): MirrorStatus {
  return { pendingFailures: failures, lastError };
}

/** Cleared by a successful full sync, which supersedes every failed push. */
export function clearMirrorFailures(): void {
  failures = 0;
  lastError = null;
}

/**
 * Run a push without letting its failure escape.
 *
 * An unhandled rejection here would surface as a console error on an action
 * that, from the user's side, succeeded — the row is in the local database
 * and on screen.
 */
function detach(work: Promise<unknown>): void {
  void work.catch((error: unknown) => {
    failures++;
    lastError = error instanceof Error ? error.message : String(error);
    // Kept at warn: the local write succeeded, so this is a degraded backup,
    // not a failed user action.
    console.warn('[sync] cloud mirror failed; will reconcile on next sync', error);
  });
}

export const mirror = {
  pushTransactions(txs: Transaction[]): void {
    if (txs.length > 0) detach(cloud.pushTransactions(txs));
  },
  deleteTransactions(ids: string[]): void {
    if (ids.length > 0) detach(cloud.deleteTransactionsRemote(ids));
  },
  pushSnapshot(snapshot: PortfolioSnapshot): void {
    detach(cloud.pushSnapshot(snapshot));
  },
  pushBudgetEntries(entries: BudgetEntry[]): void {
    if (entries.length > 0) detach(cloud.pushBudgetEntries(entries));
  },
  deleteBudgetEntries(ids: string[]): void {
    if (ids.length > 0) detach(cloud.deleteBudgetEntriesRemote(ids));
  },
};
