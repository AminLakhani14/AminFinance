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
import type {
  Transaction,
  PortfolioSnapshot,
  BudgetEntry,
  BudgetLog,
  BudgetChange,
  CashAccount,
  Liability,
  DebtRepayment,
  Goal,
} from '@aminfinance/shared';
import { mirror } from './mirror';

/** A daily portfolio valuation, keyed by its normalized timestamp. */
export interface StoredSnapshot extends PortfolioSnapshot {
  id: number;
}

const db = new Dexie('aminfinance') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>;
  snapshots: EntityTable<StoredSnapshot, 'id'>;
  budget: EntityTable<BudgetEntry, 'id'>;
  budgetLogs: EntityTable<BudgetLog, 'id'>;
  budgetChanges: EntityTable<BudgetChange, 'id'>;
  cash: EntityTable<CashAccount, 'id'>;
  liabilities: EntityTable<Liability, 'id'>;
  debtRepayments: EntityTable<DebtRepayment, 'id'>;
  goals: EntityTable<Goal, 'id'>;
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

// v4 adds the day-by-day log behind each sheet row. A new table rather than
// new rows in `budget`: the entry stays the single aggregate every chart,
// total, and export already reads, and the logs are the detail behind it.
// `[month+itemId]` is the only query the sheet makes — "this row's payments,
// this month" — and it is the compound index that serves it.
db.version(4).stores({
  budgetLogs: 'id, month, itemId, timestamp, [month+itemId]',
});

// v5 adds what the portfolio deliberately has no room for: cash balances,
// outstanding debts, and savings goals.
//
// Cash is the gap `reconcile.ts` left on purpose — it drops stablecoin
// balances during Binance sync because there is no pair to price them
// against, which is right for a position but left the app unable to answer
// how much cash the user holds. Three features need that answer: zakat (cash
// is fully zakatable), the emergency-fund runway, and any honest net worth.
//
// All three are small, manually-maintained tables — a handful of rows each —
// so only `id` is indexed. There is no query here that scans by anything
// else, and indexing a five-row table by `kind` would cost more to maintain
// than it could ever save.
db.version(5).stores({
  cash: 'id',
  liabilities: 'id',
  goals: 'id',
});

// v6 links a debt to the budget row that pays it. `[liabilityId+month]` is the
// only query this table serves — "what did this debt receive in September" —
// and it is unique by construction: one cumulative repayment row per debt per
// month is what makes the link idempotent under repeated sheet edits.
db.version(6).stores({
  debtRepayments: 'id, liabilityId, month, [liabilityId+month]',
});

// v7 records when each typed sheet amount changed, for the month's history.
// Additive like v4: the entry stays the aggregate everything else reads, and
// the changes are the dated detail behind a typed box. `month` serves the
// history's read; `[month+itemId]` serves the writes, which touch one row.
db.version(7).stores({
  budgetChanges: 'id, month, itemId, [month+itemId]',
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

/** Start of the local day, so changes made at 9am and at 6pm on one day merge. */
function dayStart(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * When an amount typed into `month`'s sheet right now happened: now, when that
 * sheet is the current month. Typed into any other month's sheet, today is not
 * a date inside it, so the day is recorded as unknown rather than invented.
 */
function typedTimestamp(month: string): number | null {
  const now = Date.now();
  return monthKey(now) === month ? now : null;
}

/**
 * Record a signed change to one sheet row, for the month's history.
 *
 * Merged with an unnoted change to the same row on the same day, so a debounce
 * firing mid-word or a same-day typo fix stays one line; a change that nets to
 * nothing is removed. A noted change never merges — the note belongs to its
 * own amount. Runs inside the caller's transaction, which must include
 * `budgetChanges`.
 */
async function recordChange(params: {
  month: string;
  itemId: string;
  delta: number;
  currency: string;
  timestamp: number | null;
  note?: string | undefined;
}): Promise<void> {
  const { month, itemId, delta, currency, timestamp } = params;
  const note = params.note?.trim();
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return;

  if (!note) {
    const sameDay = (
      await db.budgetChanges.where('[month+itemId]').equals([month, itemId]).toArray()
    ).find(
      (c) =>
        !c.note &&
        (timestamp === null
          ? c.timestamp === null
          : c.timestamp !== null && dayStart(c.timestamp) === dayStart(timestamp)),
    );
    if (sameDay) {
      const merged = sameDay.delta + delta;
      if (Math.abs(merged) < 1e-9) await db.budgetChanges.delete(sameDay.id);
      else await db.budgetChanges.update(sameDay.id, { delta: merged, timestamp });
      return;
    }
  }

  await db.budgetChanges.add({
    id: crypto.randomUUID(),
    itemId,
    month,
    delta,
    currency,
    timestamp,
    ...(note ? { note } : {}),
  });
}

/** Forget one row's recorded changes — when the row is deleted, or its logs take over. */
async function clearChanges(month: string, itemId: string): Promise<void> {
  await db.budgetChanges.where('[month+itemId]').equals([month, itemId]).delete();
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
    const itemId = entry.itemId;
    await db.transaction('rw', db.budget, db.budgetLogs, db.budgetChanges, async () => {
      // A row with dated payments is owned by them, so an amount added through
      // the dialog becomes one more payment. Merged into the entry instead,
      // it would sit in the total with no log behind it, and the next log
      // would recompute the total and silently drop it.
      const logged = await db.budgetLogs.where('[month+itemId]').equals([month, itemId]).count();
      if (logged > 0) {
        await db.budgetLogs.add({
          id: crypto.randomUUID(),
          itemId,
          month,
          amount: entry.amount,
          currency: entry.currency,
          timestamp: entry.timestamp,
          ...(entry.note?.trim() ? { note: entry.note.trim() } : {}),
        });
        await syncItemTotalFromLogs({
          month,
          itemId,
          kind: entry.kind,
          category: entry.category,
          currency: entry.currency,
        });
        return;
      }

      const existing = await db.budget
        .where('[month+itemId]')
        .equals([month, itemId])
        .first();

      // The dialog asks for a date, so this addition is dated by it.
      await recordChange({
        month,
        itemId,
        delta: entry.amount,
        currency: entry.currency,
        timestamp: entry.timestamp,
        note: entry.note,
      });

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
  await db.transaction('rw', db.budget, db.budgetLogs, db.budgetChanges, async () => {
    const entry = await db.budget.get(id);
    await db.budget.delete(id);

    // The logs are that entry's detail, not rows in their own right. Left
    // behind, they would re-create the entry with the next edit and make a
    // deleted row reappear with its old total. Its recorded changes go too:
    // they describe an amount that no longer exists.
    if (entry?.itemId) {
      await db.budgetLogs
        .where('[month+itemId]')
        .equals([entry.month, entry.itemId])
        .delete();
      await clearChanges(entry.month, entry.itemId);
    }
  });
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

  await db.transaction('rw', db.budget, db.budgetLogs, db.budgetChanges, async () => {
    // A row with logged payments is owned by those logs — its total is their
    // sum. Letting a typed amount through here would overwrite that total with
    // a figure no log supports, and the next log would silently overwrite it
    // back. The UI makes the box read-only in this state; this is the guard
    // that keeps a stale render or a queued debounce from getting round it.
    const logged = await db.budgetLogs
      .where('[month+itemId]')
      .equals([month, itemId])
      .count();
    if (logged > 0) return;

    const existing = await db.budget
      .where('[month+itemId]')
      .equals([month, itemId])
      .first();

    if (!Number.isFinite(amount) || amount <= 0) {
      if (existing) {
        await db.budget.delete(existing.id);
        mirror.deleteBudgetEntries([existing.id]);
        // A cleared box means nothing was spent here; its history goes with it.
        await clearChanges(month, itemId);
      }
      return;
    }

    // The history's record of this edit: how far the figure moved, and when.
    await recordChange({
      month,
      itemId,
      delta: amount - (existing?.amount ?? 0),
      currency,
      timestamp: params.timestamp ?? typedTimestamp(month),
    });

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
 * Give a date to the part of a typed row's amount the history has none for.
 *
 * That part is whatever the row's dated changes do not account for: amounts
 * typed before changes were recorded, typed into a past month's sheet, copied
 * forward from last month, or synced from another device. It becomes one
 * dated change, and any undated changes it replaces are removed, so the row's
 * changes again add up to its amount.
 *
 * Refuses a date outside the row's month — the history is one month's, and a
 * line dated in another would sit on a page it does not belong to.
 */
export async function dateUndatedAmount(params: {
  month: string;
  itemId: string;
  timestamp: number;
}): Promise<void> {
  const { month, itemId, timestamp } = params;
  if (monthKey(timestamp) !== month) return;

  await db.transaction('rw', db.budget, db.budgetLogs, db.budgetChanges, async () => {
    // Logged rows date their payments one by one, in the row's log.
    const logged = await db.budgetLogs.where('[month+itemId]').equals([month, itemId]).count();
    if (logged > 0) return;

    const entry = await db.budget.where('[month+itemId]').equals([month, itemId]).first();
    if (!entry) return;

    const changes = await db.budgetChanges.where('[month+itemId]').equals([month, itemId]).toArray();
    const dated = changes.filter((c) => c.timestamp !== null);
    const undated = entry.amount - dated.reduce((sum, c) => sum + c.delta, 0);

    await db.budgetChanges.bulkDelete(changes.filter((c) => c.timestamp === null).map((c) => c.id));
    if (Math.abs(undated) < 1e-9) return;
    await db.budgetChanges.add({
      id: crypto.randomUUID(),
      itemId,
      month,
      delta: undated,
      currency: entry.currency,
      timestamp,
    });
  });
}

/** Every logged payment for one sheet row in one month, newest first. */
export async function getBudgetLogs(
  month: string,
  itemId: string,
): Promise<BudgetLog[]> {
  const rows = await db.budgetLogs
    .where('[month+itemId]')
    .equals([month, itemId])
    .toArray();
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/** This month's logs grouped by item, for rendering counts without N queries. */
export async function getBudgetLogsForMonth(
  month: string,
): Promise<Map<string, BudgetLog[]>> {
  const rows = await db.budgetLogs.where('month').equals(month).toArray();
  const map = new Map<string, BudgetLog[]>();
  for (const row of rows) {
    const list = map.get(row.itemId);
    if (list) list.push(row);
    else map.set(row.itemId, [row]);
  }
  for (const list of map.values()) list.sort((a, b) => b.timestamp - a.timestamp);
  return map;
}

/**
 * Re-point a sheet row's entry at the sum of its logs.
 *
 * The invariant this whole feature rests on: once a row has logs, they are the
 * truth and the entry is their total. Recomputing from the logs rather than
 * adding and subtracting deltas means an edit, a delete, and a failed write
 * all converge on the same figure — a drifting running total cannot be fixed
 * by the next operation, but a recomputed one is correct the moment it lands.
 *
 * Runs inside the caller's transaction so the log and the aggregate commit
 * together; a reader can never see a payment that its total does not include.
 */
async function syncItemTotalFromLogs(params: {
  month: string;
  itemId: string;
  kind: BudgetEntry['kind'];
  category: BudgetEntry['category'];
  currency: string;
}): Promise<void> {
  const { month, itemId, kind, category, currency } = params;

  const logs = await db.budgetLogs
    .where('[month+itemId]')
    .equals([month, itemId])
    .toArray();
  const total = logs.reduce((sum, log) => sum + log.amount, 0);

  const existing = await db.budget
    .where('[month+itemId]')
    .equals([month, itemId])
    .first();

  // The last log was deleted. Clearing the entry rather than leaving a zero
  // keeps the row blank again, which is what "I did not spend on this" looks
  // like everywhere else on the page.
  if (total <= 0) {
    if (existing) {
      await db.budget.delete(existing.id);
      mirror.deleteBudgetEntries([existing.id]);
    }
    return;
  }

  if (existing) {
    await db.budget.update(existing.id, { amount: total, currency });
    mirror.pushBudgetEntries([{ ...existing, amount: total, currency }]);
    return;
  }

  // Dated to the earliest payment, not the 1st: the entry now stands for real
  // transactions, and filing them under a day nothing happened would be a
  // date the user never entered.
  const earliest = logs.reduce(
    (min, log) => Math.min(min, log.timestamp),
    Number.POSITIVE_INFINITY,
  );

  const created: BudgetEntry = {
    id: crypto.randomUUID(),
    kind,
    category,
    itemId,
    amount: total,
    currency,
    timestamp: Number.isFinite(earliest) ? earliest : Date.now(),
    month,
    recurring: true,
  };
  await db.budget.add(created);
  mirror.pushBudgetEntries([created]);
}

/**
 * Record one dated payment against a sheet row.
 *
 * If the row already held a typed amount and has no logs yet, that amount is
 * absorbed rather than discarded — the user typed real money into the box,
 * and silently dropping it the moment they logged a coffee would lose a figure
 * they entered deliberately. When the history recorded that amount as dated
 * additions, each becomes its own log, so the day-by-day record survives the
 * switch; otherwise it is carried as one log.
 */
export async function addBudgetLog(params: {
  month: string;
  itemId: string;
  kind: BudgetEntry['kind'];
  category: BudgetEntry['category'];
  amount: number;
  currency: string;
  timestamp: number;
  note?: string;
}): Promise<void> {
  const { month, itemId, kind, category, amount, currency, timestamp, note } =
    params;
  if (!Number.isFinite(amount) || amount <= 0) return;

  await db.transaction('rw', db.budget, db.budgetLogs, db.budgetChanges, async () => {
    const existingLogs = await db.budgetLogs
      .where('[month+itemId]')
      .equals([month, itemId])
      .count();

    if (existingLogs === 0) {
      const entry = await db.budget
        .where('[month+itemId]')
        .equals([month, itemId])
        .first();
      if (entry && entry.amount > 0) {
        const changes = await db.budgetChanges
          .where('[month+itemId]')
          .equals([month, itemId])
          .toArray();
        const recorded = changes.reduce((sum, c) => sum + c.delta, 0);
        // Only a clean record converts one-for-one: every change dated, every
        // one an addition (logs cannot be negative), and together the whole
        // amount. Anything less is carried as a single log, dated to the last
        // recorded edit where there was one.
        const convertible =
          changes.length > 0 &&
          changes.every((c) => c.timestamp !== null && c.delta > 0) &&
          Math.abs(recorded - entry.amount) < 0.005;

        if (convertible) {
          await db.budgetLogs.bulkAdd(
            changes.map((c) => ({
              id: crypto.randomUUID(),
              itemId,
              month,
              amount: c.delta,
              currency: c.currency,
              timestamp: c.timestamp as number,
              ...(c.note ? { note: c.note } : {}),
            })),
          );
        } else {
          const lastEdit = changes.reduce<number | null>(
            (latest, c) => (c.timestamp !== null && (latest === null || c.timestamp > latest) ? c.timestamp : latest),
            null,
          );
          await db.budgetLogs.add({
            id: crypto.randomUUID(),
            itemId,
            month,
            amount: entry.amount,
            currency: entry.currency,
            timestamp: lastEdit ?? entry.timestamp,
            note: entry.note ?? 'Carried from the typed amount',
          });
        }
      }
    }

    // From here the logs are the row's history; its recorded changes would
    // only describe the same money twice.
    await clearChanges(month, itemId);

    await db.budgetLogs.add({
      id: crypto.randomUUID(),
      itemId,
      month,
      amount,
      currency,
      // Logged against the month whose sheet is open, so a payment cannot land
      // in a month the user is not looking at even if the date says otherwise.
      timestamp,
      ...(note?.trim() ? { note: note.trim() } : {}),
    });

    await syncItemTotalFromLogs({ month, itemId, kind, category, currency });
  });
}

/**
 * Patch one logged payment, then re-total its row.
 *
 * `note: null` clears the note. It cannot be `undefined`: under
 * `exactOptionalPropertyTypes` that means "leave this field alone", so there
 * would be no way to express emptying a note the user had deleted the text of.
 */
export async function updateBudgetLog(
  id: string,
  changes: {
    amount?: number;
    timestamp?: number;
    note?: string | null;
  },
  context: {
    kind: BudgetEntry['kind'];
    category: BudgetEntry['category'];
  },
): Promise<void> {
  await db.transaction('rw', db.budget, db.budgetLogs, async () => {
    const log = await db.budgetLogs.get(id);
    if (!log) return;

    const { note, ...rest } = changes;
    const cleared = note !== undefined && (note === null || note.trim() === '');

    // Rebuilt and `put` rather than patched: clearing a note has to *remove*
    // the key, and Dexie's update spec has no way to say that — it treats a
    // missing key as "leave it alone". Spreading the row minus its note is the
    // one form where absence is genuinely absence.
    const { note: _dropped, ...withoutNote } = log;
    const next: BudgetLog = {
      ...withoutNote,
      ...rest,
      // `month` is deliberately not recomputed from a new timestamp: the log
      // belongs to the sheet row the user opened, and moving it to another
      // month would make it vanish from the page it was edited on.
      month: log.month,
      ...(cleared
        ? {}
        : note !== undefined
          ? { note: note.trim() }
          : log.note !== undefined
            ? { note: log.note }
            : {}),
    };

    await db.budgetLogs.put(next);

    await syncItemTotalFromLogs({
      month: log.month,
      itemId: log.itemId,
      currency: log.currency,
      ...context,
    });
  });
}

/** Remove one logged payment, then re-total its row. */
export async function deleteBudgetLog(
  id: string,
  context: {
    kind: BudgetEntry['kind'];
    category: BudgetEntry['category'];
  },
): Promise<void> {
  await db.transaction('rw', db.budget, db.budgetLogs, async () => {
    const log = await db.budgetLogs.get(id);
    if (!log) return;

    await db.budgetLogs.delete(id);

    await syncItemTotalFromLogs({
      month: log.month,
      itemId: log.itemId,
      currency: log.currency,
      ...context,
    });
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

/* ------------------------------------------------------------------ *
 * Cash, liabilities, goals
 *
 * Local-only for now: `mirror` has no cash/goal channel, and adding one means
 * a Supabase table plus a `cloud.ts` round-trip. Until that exists these
 * three tables do not reach the cloud backup, which Settings must say plainly
 * rather than letting the user assume a synced balance is safe.
 * ------------------------------------------------------------------ */

export async function getCashAccounts(): Promise<CashAccount[]> {
  return db.cash.toArray();
}

export async function putCashAccount(account: CashAccount): Promise<void> {
  await db.cash.put(account);
}

export async function deleteCashAccount(id: string): Promise<void> {
  await db.cash.delete(id);
}

export async function getLiabilities(): Promise<Liability[]> {
  return db.liabilities.toArray();
}

export async function putLiability(liability: Liability): Promise<void> {
  await db.liabilities.put(liability);
  // Linking a debt to a sheet row, or changing its rate, changes what its
  // history means — recompute immediately rather than waiting for the next
  // budget edit.
  await syncLinkedDebts().catch(() => {});
}

export async function deleteLiability(id: string): Promise<void> {
  await db.transaction('rw', [db.liabilities, db.debtRepayments], async () => {
    await db.liabilities.delete(id);
    // Orphaned repayments would be invisible but would reattach if an id were
    // ever reused, silently reducing a different debt.
    const rows = await db.debtRepayments.where('liabilityId').equals(id).toArray();
    if (rows.length > 0) await db.debtRepayments.bulkDelete(rows.map((r) => r.id));
  });
}

/**
 * Recompute every linked debt's balance from the budget sheet.
 *
 * Called after any write that could change what a debt received: a typed
 * amount, a dated log, a deletion, a month carry-forward. It is safe to call
 * on all of them because it is idempotent by construction — it does not
 * subtract from the balance, it *recomputes* the balance from the original
 * principal and the full repayment history.
 *
 * That property is the whole design. The budget sheet is a form: a user types
 * 12,000, corrects it to 10,000, then logs a payment. A decrementing
 * implementation would take 34,000 off a debt that received 10,000, and the
 * error would be silent and permanent.
 *
 * Returns the ids of debts whose balance actually moved, so a caller can tell
 * whether anything needs re-rendering.
 */
export async function syncLinkedDebts(): Promise<string[]> {
  const { replayRepayments } = await import('@/lib/calc/debt');

  return db.transaction(
    'rw',
    [db.liabilities, db.debtRepayments, db.budget],
    async () => {
      const linked = (await db.liabilities.toArray()).filter((l) => l.linkedItemId);
      if (linked.length === 0) return [];

      const changed: string[] = [];

      for (const liability of linked) {
        const itemId = liability.linkedItemId;
        if (!itemId) continue;

        // Every month's entry for the linked row. The entry's `amount` is
        // already the authoritative total — when dated logs exist it is their
        // sum, maintained by `addBudgetLog`/`deleteBudgetLog` — so reading it
        // here avoids double-counting a payment recorded both ways.
        const entries = await db.budget.where('itemId').equals(itemId).toArray();

        // A month may be recomputed; the rest are read as they stand. Keyed
        // by month so an edited month replaces rather than appends.
        const byMonth = new Map<string, number>();
        for (const entry of entries) {
          if (entry.kind !== 'expense') continue;
          if (!Number.isFinite(entry.amount) || entry.amount <= 0) continue;
          byMonth.set(entry.month, (byMonth.get(entry.month) ?? 0) + entry.amount);
        }

        const existing = await db.debtRepayments
          .where('liabilityId')
          .equals(liability.id)
          .toArray();
        const existingByMonth = new Map(existing.map((r) => [r.month, r]));

        // Drop repayments for months the sheet no longer records — a cleared
        // box must give the principal back, not leave it permanently reduced.
        const stale = existing.filter((r) => !byMonth.has(r.month));
        if (stale.length > 0) {
          await db.debtRepayments.bulkDelete(stale.map((r) => r.id));
        }

        const rows: DebtRepayment[] = [...byMonth.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([rowMonth, amountPaid]) => {
            const prior = existingByMonth.get(rowMonth);
            return {
              id: prior?.id ?? crypto.randomUUID(),
              liabilityId: liability.id,
              month: rowMonth,
              amountPaid,
              // Placeholders; `replayRepayments` fills these in against the
              // running balance, which is the only place interest can be
              // computed correctly.
              principalPaid: 0,
              interestPaid: 0,
              currency: liability.currency,
              recordedAt: Date.now(),
            };
          });

        const { balance, rows: replayed } = replayRepayments(liability, rows);

        if (replayed.length > 0) await db.debtRepayments.bulkPut(replayed);

        // Rounded before comparing: a float recomputation can differ in the
        // last bits without anything having actually changed, and writing on
        // every call would churn the table and re-render the page forever.
        if (Math.round(balance * 100) !== Math.round(liability.balance * 100)) {
          await db.liabilities.update(liability.id, { balance });
          changed.push(liability.id);
        }
      }

      return changed;
    },
  );
}

/**
 * Keep linked debts in step with the budget, automatically.
 *
 * Hooked onto the table rather than called from each write, because there are
 * six paths that can change what a debt received — a typed amount, a dated
 * log, two kinds of edit, a delete, a carry-forward — and a feature that
 * silently stops working when a seventh is added later is not worth having.
 *
 * Debounced and fired after the transaction settles: the hooks run *inside*
 * the caller's write transaction, and re-entering Dexie there would deadlock
 * on the same tables. A short delay also collapses a bulk carry-forward's
 * dozens of inserts into one recomputation.
 */
let debtSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDebtSync(): void {
  if (debtSyncTimer) clearTimeout(debtSyncTimer);
  debtSyncTimer = setTimeout(() => {
    debtSyncTimer = null;
    // Failures are non-fatal: the balance stays as it was and the next edit
    // recomputes it from scratch, since nothing here is incremental.
    void syncLinkedDebts().catch(() => {});
  }, 150);
}

db.budget.hook('creating', () => {
  scheduleDebtSync();
});
db.budget.hook('updating', () => {
  scheduleDebtSync();
});
db.budget.hook('deleting', () => {
  scheduleDebtSync();
});

/** Repayment history for one debt, oldest first. */
export async function getDebtRepayments(liabilityId: string): Promise<DebtRepayment[]> {
  const rows = await db.debtRepayments.where('liabilityId').equals(liabilityId).toArray();
  return rows.sort((a, b) => a.month.localeCompare(b.month));
}

export async function getGoals(): Promise<Goal[]> {
  return db.goals.toArray();
}

export async function putGoal(goal: Goal): Promise<void> {
  await db.goals.put(goal);
}

export async function deleteGoal(id: string): Promise<void> {
  await db.goals.delete(id);
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
  // Array form rather than positional: Dexie's varargs overloads stop at
  // five tables and this transaction spans nine.
  await db.transaction(
    'rw',
    [
      db.transactions,
      db.snapshots,
      db.budget,
      db.budgetLogs,
      db.budgetChanges,
      db.cash,
      db.liabilities,
      db.debtRepayments,
      db.goals,
    ],
    async () => {
      await db.transactions.clear();
      await db.snapshots.clear();
      await db.budget.clear();
      // Logs are the detail behind the entries; leaving them would re-total
      // rows the reset just removed the moment one of them was edited.
      await db.budgetLogs.clear();
      await db.budgetChanges.clear();
      // Cash and debts are the most sensitive rows here — a "wipe everything"
      // that left a bank balance behind would be a broken promise, not a
      // convenience.
      await db.cash.clear();
      await db.liabilities.clear();
      await db.debtRepayments.clear();
      await db.goals.clear();
    },
  );
}
