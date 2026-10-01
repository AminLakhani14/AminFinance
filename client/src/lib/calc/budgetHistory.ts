/**
 * The month's history: every amount by the day it moved, as credits (money
 * in) and debits (money out) — a statement of the month, built from the same
 * records the totals are.
 *
 * Three sources, one per way money gets into the book:
 *
 *  - Dated payments (`BudgetLog`) for rows that keep a log. Each is a line.
 *  - Recorded changes (`BudgetChange`) for rows typed into directly. Each day's
 *    change is a line — an addition, or a correction downwards.
 *  - One-off entries outside the sheet, dated by the dialog that made them.
 *
 * Whatever part of an entry no dated record accounts for becomes a "not
 * dated" line instead of disappearing: amounts typed before changes were
 * recorded, typed into a past month, copied forward, or synced from another
 * device. That reconciliation is what keeps the statement honest — its credit
 * column always totals the month's take-home income, and its debit column the
 * month's spending, exactly as the summary tiles report them.
 *
 * Pure: no I/O, so the page can rebuild it on every write for free.
 */
import type {
  BudgetCategory,
  BudgetChange,
  BudgetEntry,
  BudgetEntryKind,
  BudgetLog,
} from '@aminfinance/shared';
import { BUDGET_GROUPS, budgetItem } from './budgetItems';
import { categoryLabel } from './budget';

export type HistorySide = 'credit' | 'debit';

export interface HistoryLine {
  id: string;
  /** Epoch ms the money moved, or null when no date was recorded. */
  timestamp: number | null;
  side: HistorySide;
  /**
   * Signed within its column. Income is a positive credit and spending a
   * positive debit; a withheld deduction is a negative credit (it never
   * reached you), and a correction downwards is negative in its own column.
   */
  amount: number;
  label: string;
  /** The note, or what kind of change this was. */
  detail: string | null;
  kind: BudgetEntryKind;
  category: BudgetCategory;
  /** The row's group colour, so a line matches its card on the sheet. */
  accent: string;
  /**
   * Where the line came from, which decides what can be done with it — only
   * an undated typed amount can be given a date from here.
   */
  source: 'payment' | 'entered' | 'one-off' | 'undated';
  itemId: string | null;
  /** True when a typed row can be dated from the history (it keeps no log). */
  datable: boolean;
}

export interface HistoryDay {
  /** Local `YYYY-MM-DD`, or `undated`. */
  key: string;
  timestamp: number | null;
  lines: HistoryLine[];
  credit: number;
  debit: number;
}

export interface MonthHistory {
  /** Newest day first; the undated group, when there is one, last. */
  days: HistoryDay[];
  credit: number;
  debit: number;
  /** Credit minus debit — the month's saving, as the summary computes it. */
  net: number;
  undatedLines: number;
}

/** Below a paisa, a remainder is rounding, not money. */
const EPSILON = 0.005;

const GROUP_ACCENT = new Map(BUDGET_GROUPS.map((g) => [g.id, g.accent]));

function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildHistory(
  entries: BudgetEntry[],
  logsByItem: Map<string, BudgetLog[]>,
  changes: BudgetChange[],
): MonthHistory {
  const changesByItem = new Map<string, BudgetChange[]>();
  for (const change of changes) {
    const list = changesByItem.get(change.itemId);
    if (list) list.push(change);
    else changesByItem.set(change.itemId, [change]);
  }

  const lines: HistoryLine[] = [];

  for (const entry of entries) {
    const item = entry.itemId ? budgetItem(entry.itemId) : undefined;
    // A deduction was withheld before the money arrived: it reduces the
    // credit column rather than adding to the debits, as the summary does.
    const inColumn = (amount: number) => (entry.kind === 'deduction' ? -amount : amount);
    const base = {
      side: (entry.kind === 'expense' ? 'debit' : 'credit') as HistorySide,
      label: entry.label ?? item?.label ?? categoryLabel(entry.category),
      kind: entry.kind,
      category: entry.category,
      accent:
        (item && GROUP_ACCENT.get(item.group)) ??
        (entry.kind === 'expense' ? 'var(--text-subtle)' : 'var(--positive)'),
      itemId: entry.itemId ?? null,
    };

    if (!entry.itemId) {
      lines.push({
        ...base,
        id: entry.id,
        timestamp: entry.timestamp,
        amount: inColumn(entry.amount),
        detail: entry.note ?? null,
        source: 'one-off',
        datable: false,
      });
      continue;
    }

    const logs = logsByItem.get(entry.itemId) ?? [];
    let accounted = 0;

    if (logs.length > 0) {
      for (const log of logs) {
        lines.push({
          ...base,
          id: log.id,
          timestamp: log.timestamp,
          amount: inColumn(log.amount),
          detail: log.note ?? null,
          source: 'payment',
          datable: false,
        });
        accounted += log.amount;
      }
    } else {
      // Undated changes are left out here on purpose: they fold into the
      // undated remainder below, which is exactly the part with no date.
      for (const change of changesByItem.get(entry.itemId) ?? []) {
        if (change.timestamp === null) continue;
        lines.push({
          ...base,
          id: change.id,
          timestamp: change.timestamp,
          amount: inColumn(change.delta),
          detail: change.note ?? (change.delta < 0 ? 'Corrected — amount lowered' : null),
          source: 'entered',
          datable: false,
        });
        accounted += change.delta;
      }
    }

    const remainder = entry.amount - accounted;
    if (Math.abs(remainder) > EPSILON) {
      lines.push({
        ...base,
        id: `${entry.id}:undated`,
        timestamp: null,
        amount: inColumn(remainder),
        detail: logs.length > 0 ? 'Not in this row’s payment log' : null,
        source: 'undated',
        datable: logs.length === 0,
      });
    }
  }

  const byDay = new Map<string, HistoryDay>();
  for (const line of lines) {
    const key = line.timestamp === null ? 'undated' : dayKey(line.timestamp);
    let day = byDay.get(key);
    if (!day) {
      day = { key, timestamp: line.timestamp, lines: [], credit: 0, debit: 0 };
      byDay.set(key, day);
    }
    day.lines.push(line);
    if (line.side === 'credit') day.credit += line.amount;
    else day.debit += line.amount;
  }

  const days = [...byDay.values()];
  for (const day of days) {
    // Within a day, latest first; undated lines money-in first, then largest.
    day.lines.sort((a, b) =>
      a.timestamp !== null && b.timestamp !== null
        ? b.timestamp - a.timestamp
        : a.side !== b.side
          ? a.side === 'credit'
            ? -1
            : 1
          : Math.abs(b.amount) - Math.abs(a.amount),
    );
  }
  days.sort((a, b) =>
    a.key === 'undated' ? 1 : b.key === 'undated' ? -1 : b.key.localeCompare(a.key),
  );

  const credit = days.reduce((sum, d) => sum + d.credit, 0);
  const debit = days.reduce((sum, d) => sum + d.debit, 0);
  return {
    days,
    credit,
    debit,
    net: credit - debit,
    undatedLines: byDay.get('undated')?.lines.length ?? 0,
  };
}
