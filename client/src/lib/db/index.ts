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
import type { Transaction, PortfolioSnapshot, BudgetEntry } from '@aminfinance/shared';
import { mirror } from './mirror';

/** A daily portfolio valuation, keyed by its normalized timestamp. */
export interface StoredSnapshot extends PortfolioSnapshot {
  id: number;
}

const db = new Dexie('aminfinance') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>;
  snapshots: EntityTable<StoredSnapshot, 'id'>;
  budget: EntityTable<BudgetEntry, 'id'>;
};

db.version(1).stores({
  // `externalId` is indexed so a Binance re-sync can dedup fills in one query
  // instead of scanning the whole table.
  transactions: 'id, symbol, assetClass, timestamp, source, externalId',
  snapshots: 'id, timestamp',
});

// v2 adds the monthly budget book. Dexie applies this additively — the two
// existing tables are untouched, so an upgrade keeps every stored trade.
db.version(2).stores({
  // `month` carries the view's primary query ("show me September"), so it is
  // indexed; `[month+kind]` lets the income and expense lists load without
  // either one scanning the other's rows.
  budget: 'id, month, kind, category, timestamp, recurring, [month+kind]',
});

// v3 indexes `itemId`, which the fill-in sheet uses to find the entry backing
// each predefined row. Additive again — no data is rewritten.
db.version(3).stores({
  budget:
    'id, month, kind, category, timestamp, recurring, itemId, [month+kind], [month+itemId]',
});

export { db };

/** All transactions, oldest first — the order cost-basis math requires. */
export async function getAllTransactions(): Promise<Transaction[]> {
  return db.transactions.orderBy('timestamp').toArray();
}

export async function addTransaction(tx: Transaction): Promise<void> {
  await db.transactions.add(tx);
  mirror.pushTransactions([tx]);
}

export async function updateTransaction(
  id: string,
  changes: Partial<Transaction>,
): Promise<void> {
  await db.transactions.update(id, changes);
  // Re-read rather than mirroring `changes`: the cloud row is upserted whole,
  // and a partial patch would blank every column the caller left out.
  const updated = await db.transactions.get(id);
  if (updated) mirror.pushTransactions([updated]);
}

export async function deleteTransaction(id: string): Promise<void> {
  await db.transactions.delete(id);
  mirror.deleteTransactions([id]);
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

  if (fresh.length > 0) {
    await db.transactions.bulkAdd(fresh);
    mirror.pushTransactions(fresh);
  }
  return fresh.length;
}

/**
 * Upsert Binance balance-reconciliation rows.
 *
 * Unlike fills, these are *derived* — each one represents the current gap
 * between a live balance and the imported history, so re-running the sync must
 * replace the previous adjustment rather than add another. Their ids are keyed
 * by pair (not by trade id), which makes `bulkPut` the correct operation:
 * adding would stack duplicates and compound the position on every sync.
 *
 * Pairs that no longer need an adjustment have their row deleted, so a
 * position that later reconciles exactly stops carrying a stale correction.
 */
export async function putReconciliations(
  adjustments: Transaction[],
  staleIds: string[] = [],
): Promise<void> {
  await db.transaction('rw', db.transactions, async () => {
    if (staleIds.length > 0) await db.transactions.bulkDelete(staleIds);
    if (adjustments.length > 0) await db.transactions.bulkPut(adjustments);
  });
  mirror.deleteTransactions(staleIds);
  mirror.pushTransactions(adjustments);
}

/**
 * Replace the manual stock book with a broker's current positions.
 *
 * Brokers report a *net* position — 504 shares at a 156.06 average — not the
 * fills that produced it. Reconciling that against a partial local history is
 * guesswork, so when the broker is the authority we take it wholesale: every
 * manual stock row is dropped and one buy per holding is written at the
 * reported average.
 *
 * Scope is deliberately narrow. Only `source: 'manual'` rows of assetClass
 * `stock` are touched, so Binance fills, their reconciliation rows, CSV
 * imports, and commodity positions all survive untouched.
 *
 * The tradeoff: per-trade history and realized P/L for these symbols are lost,
 * because the broker did not give us either. Unrealized P/L stays exact.
 */
export async function replaceStockPositions(
  positions: Array<{ symbol: string; quantity: number; averageCost: number; currency: string }>,
  asOf = Date.now(),
): Promise<{ removed: number; added: number }> {
  return db.transaction('rw', db.transactions, async () => {
    const stale = await db.transactions
      .filter((t) => t.source === 'manual' && t.assetClass === 'stock')
      .toArray();

    await db.transactions.bulkDelete(stale.map((t) => t.id));

    const fresh: Transaction[] = positions
      .filter((p) => p.quantity > 0)
      .map((p) => ({
        id: `broker-${p.symbol}-${asOf}`,
        symbol: p.symbol.toUpperCase(),
        assetClass: 'stock',
        type: 'buy',
        quantity: p.quantity,
        price: p.averageCost,
        fee: 0,
        currency: p.currency,
        timestamp: asOf,
        source: 'manual',
        notes: `Position as reported by broker: ${p.quantity} @ ${p.averageCost}`,
      }));

    if (fresh.length > 0) await db.transactions.bulkAdd(fresh);

    // Mirrored inside the transaction body but after both writes, so the
    // cloud never sees a delete that the local rollback then undoes.
    mirror.deleteTransactions(stale.map((t) => t.id));
    mirror.pushTransactions(fresh);

    return { removed: stale.length, added: fresh.length };
  });
}

/** Upsert a day's valuation. Same-day recomputes overwrite rather than append. */
export async function putSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  await db.snapshots.put({ ...snapshot, id: snapshot.timestamp });
  mirror.pushSnapshot(snapshot);
}

export async function getSnapshots(): Promise<StoredSnapshot[]> {
  return db.snapshots.orderBy('timestamp').toArray();
}

/**
 * `YYYY-MM` for a timestamp, in **local** time.
 *
 * `toISOString().slice(0, 7)` would be wrong here: it converts to UTC first,
 * so a salary credited at 9pm on the 31st in Karachi (UTC+5) files itself under
 * the next month. Budgets are a local-calendar concept, so the local parts are
 * the correct source.
 */
export function monthKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Every entry for one `YYYY-MM`, newest first. */
export async function getBudgetEntries(month: string): Promise<BudgetEntry[]> {
  const rows = await db.budget.where('month').equals(month).toArray();
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/** Whole book, for the trend strip and the month picker. */
export async function getAllBudgetEntries(): Promise<BudgetEntry[]> {
  return db.budget.orderBy('timestamp').toArray();
}

/**
 * Insert an entry, deriving `month` from its timestamp.
 *
 * Callers never pass `month` — it is an index over `timestamp`, and letting
 * two sources set it is how they drift apart.
 */
export async function addBudgetEntry(
  entry: Omit<BudgetEntry, 'month'>,
): Promise<void> {
  const month = monthKey(entry.timestamp);

  // An entry bound to a sheet item must merge with whatever that box already
  // holds, not sit beside it. Two rows for one item would make the sheet show
  // one figure while the totals counted another — and the box can only
  // display one of them.
  if (entry.itemId) {
    await db.transaction('rw', db.budget, async () => {
      const existing = await db.budget
        .where('[month+itemId]')
        .equals([month, entry.itemId!])
        .first();

      if (existing) {
        // Added, not replaced: two pay-outs in one month are two real amounts,
        // and overwriting would erase the first without telling anyone.
        const merged = { ...existing, amount: existing.amount + entry.amount };
        await db.budget.update(existing.id, { amount: merged.amount });
        mirror.pushBudgetEntries([merged]);
        return;
      }
      const created = { ...entry, month };
      await db.budget.add(created);
      mirror.pushBudgetEntries([created]);
    });
    return;
  }

  const created = { ...entry, month };
  await db.budget.add(created);
  mirror.pushBudgetEntries([created]);
}

/** Patch an entry, keeping `month` consistent when the date moves. */
export async function updateBudgetEntry(
  id: string,
  changes: Partial<Omit<BudgetEntry, 'month'>>,
): Promise<void> {
  const withMonth: Partial<BudgetEntry> =
    changes.timestamp === undefined
      ? changes
      : { ...changes, month: monthKey(changes.timestamp) };
  await db.budget.update(id, withMonth);
  // Whole row, not the patch — the cloud upsert replaces every column.
  const updated = await db.budget.get(id);
  if (updated) mirror.pushBudgetEntries([updated]);
}

export async function deleteBudgetEntry(id: string): Promise<void> {
  await db.budget.delete(id);
  mirror.deleteBudgetEntries([id]);
}

/**
 * Write the amount a user typed into one predefined sheet row.
 *
 * Keyed on `[month, itemId]` rather than on a row id, because the sheet row
 * exists before any entry does — the user is filling in a blank, and the first
 * keystroke has to create the record while every later one updates that same
 * record. Matching on the pair is what makes the box behave like a field
 * instead of an append-only log.
 *
 * An amount of zero (or a cleared box) deletes the row instead of storing a
 * zero: a month with no gas bill should have no gas entry, not one worth
 * nothing that still shows up in counts and breakdowns.
 */
export async function setBudgetItemAmount(params: {
  month: string;
  itemId: string;
  kind: BudgetEntry['kind'];
  category: BudgetEntry['category'];
  amount: number;
  currency: string;
  /** Day to file it under. Defaults to the 1st of `month`. */
  timestamp?: number;
}): Promise<void> {
  const { month, itemId, kind, category, amount, currency } = params;

  await db.transaction('rw', db.budget, async () => {
    const existing = await db.budget
      .where('[month+itemId]')
      .equals([month, itemId])
      .first();

    if (!Number.isFinite(amount) || amount <= 0) {
      if (existing) {
        await db.budget.delete(existing.id);
        mirror.deleteBudgetEntries([existing.id]);
      }
      return;
    }

    if (existing) {
      await db.budget.update(existing.id, { amount, currency, kind, category });
      mirror.pushBudgetEntries([{ ...existing, amount, currency, kind, category }]);
      return;
    }

    const [year, monthNumber] = month.split('-').map(Number);
    const timestamp =
      params.timestamp ?? new Date(year!, monthNumber! - 1, 1).getTime();

    const created: BudgetEntry = {
      id: crypto.randomUUID(),
      kind,
      category,
      itemId,
      amount,
      currency,
      timestamp,
      month,
      // Sheet rows are the fixed monthly items by definition, which is what
      // makes "copy fixed items" pick them up next month.
      recurring: true,
    };
    await db.budget.add(created);
    mirror.pushBudgetEntries([created]);
  });
}

/**
 * Adopt pre-existing entries into their matching sheet rows.
 *
 * Entries written before the sheet existed carry a category but no `itemId`,
 * so no box can claim them: the amount counts in the totals while the form
 * stays blank, and the same money appears again under "one-off entries". That
 * is not a cosmetic mismatch — the page contradicts itself about what you
 * earned.
 *
 * `resolve` is injected rather than imported so this module stays free of the
 * item catalog, which imports types from here.
 *
 * Idempotent: rows that already carry an `itemId` are skipped, and where a
 * month already has a row for the target item the two are merged, so running
 * this on every startup costs one indexed scan and changes nothing twice.
 *
 * Returns how many rows were adopted.
 */
export async function adoptLegacyEntries(
  resolve: (kind: BudgetEntry['kind'], category: BudgetEntry['category']) => string | undefined,
): Promise<number> {
  return db.transaction('rw', db.budget, async () => {
    const orphans = await db.budget.filter((e) => !e.itemId).toArray();
    if (orphans.length === 0) return 0;

    let adopted = 0;

    for (const orphan of orphans) {
      const itemId = resolve(orphan.kind, orphan.category);
      // No matching row: it is a genuine one-off and belongs in the list.
      if (!itemId) continue;

      const existing = await db.budget
        .where('[month+itemId]')
        .equals([orphan.month, itemId])
        .first();

      if (existing) {
        // Both describe the same line item in the same month, so they sum —
        // dropping either would lose money the user entered.
        const amount = existing.amount + orphan.amount;
        await db.budget.update(existing.id, { amount });
        await db.budget.delete(orphan.id);
        mirror.pushBudgetEntries([{ ...existing, amount }]);
        mirror.deleteBudgetEntries([orphan.id]);
      } else {
        await db.budget.update(orphan.id, { itemId });
        mirror.pushBudgetEntries([{ ...orphan, itemId }]);
      }
      adopted++;
    }

    return adopted;
  });
}

/** Amounts already entered for this month, keyed by item id. */
export async function getBudgetItemAmounts(
  month: string,
): Promise<Map<string, BudgetEntry>> {
  const rows = await db.budget.where('month').equals(month).toArray();
  const map = new Map<string, BudgetEntry>();
  for (const row of rows) {
    if (row.itemId) map.set(row.itemId, row);
  }
  return map;
}

/**
 * Copy the previous month's recurring entries into `month`.
 *
 * Recurring rows are *templates*, not standing orders — rent is due every
 * month but the amount can change, and auto-posting it would quietly invent
 * spending that may not have happened. So this only runs when the user asks,
 * and it skips anything already carried over (matched on kind + category +
 * note), which makes pressing the button twice a no-op rather than a
 * double-charge.
 *
 * Returns the number of rows actually written.
 */
export async function carryForwardRecurring(
  fromMonth: string,
  toMonth: string,
): Promise<number> {
  return db.transaction('rw', db.budget, async () => {
    const templates = await db.budget
      .where('month')
      .equals(fromMonth)
      .filter((e) => e.recurring)
      .toArray();
    if (templates.length === 0) return 0;

    // Identity for dedup: the predefined item when there is one, since
    // electricity and gas are both `utilities` with no note and would
    // otherwise collide into a single carried row.
    const identity = (e: BudgetEntry) =>
      e.itemId ? `item:${e.itemId}` : `${e.kind}|${e.category}|${e.note ?? ''}`;

    const existing = await db.budget.where('month').equals(toMonth).toArray();
    const seen = new Set(existing.map(identity));

    // Same day-of-month as the template, clamped to months that are shorter —
    // a rent entry dated the 31st must land on Feb 28, not spill into March.
    const [year, monthNumber] = toMonth.split('-').map(Number);
    const fresh: BudgetEntry[] = [];

    for (const template of templates) {
      const key = identity(template);
      if (seen.has(key)) continue;
      seen.add(key);

      const lastDay = new Date(year!, monthNumber!, 0).getDate();
      const day = Math.min(new Date(template.timestamp).getDate(), lastDay);

      fresh.push({
        ...template,
        id: crypto.randomUUID(),
        month: toMonth,
        timestamp: new Date(year!, monthNumber! - 1, day).getTime(),
      });
    }

    if (fresh.length > 0) {
      await db.budget.bulkAdd(fresh);
      mirror.pushBudgetEntries(fresh);
    }
    return fresh.length;
  });
}

/**
 * Wipe everything local. Used by Settings → Reset.
 *
 * Deliberately *not* mirrored. A reset clears this device; the cloud copy is
 * the backup that makes that safe, and deleting both would turn a local
 * cleanup into an unrecoverable wipe of every device at once. Settings offers
 * cloud deletion as its own, separately-confirmed action.
 */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.transactions, db.snapshots, db.budget, async () => {
    await db.transactions.clear();
    await db.snapshots.clear();
    await db.budget.clear();
  });
}
