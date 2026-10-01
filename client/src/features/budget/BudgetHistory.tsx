/**
 * The month as a statement: what came in and what went out, day by day.
 *
 * The sheet above answers "how much went on groceries this month"; this
 * answers "what did I spend on the 14th". Every line sits in a Credit (money
 * in) or Debit (money out) column, and the filter narrows the statement to
 * either side on its own.
 *
 * Amounts typed into the sheet are dated the day they are typed, payments in
 * a row's log carry their own dates, and one-off entries the date given in the
 * dialog. Anything with no date on record — typed before this history
 * existed, typed into a past month, copied from last month — is gathered under
 * "Not dated" with a control to give it one, rather than being dropped or
 * filed under a day it did not happen. The columns therefore always total the
 * month's income and spending exactly as the tiles at the top of the page do.
 */
import { useMemo, useState } from 'react';
import { CalendarPlus, Check, History, X } from 'lucide-react';
import type { BudgetChange, BudgetEntry, BudgetLog } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import {
  buildHistory,
  type HistoryDay,
  type HistoryLine,
  type HistorySide,
} from '@/lib/calc/budgetHistory';
import { formatMonth } from '@/lib/calc/budget';
import { defaultDate, monthBounds, timestampFromInput } from '@/lib/calc/dateInput';
import { dateUndatedAmount } from '@/lib/db';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { cn } from '@/lib/utils';

type View = 'all' | HistorySide;

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'credit', label: 'Credit · money in' },
  { id: 'debit', label: 'Debit · money out' },
];

/** "Mon, 22 Sep" — the month is already in the card's title. */
function dayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function BudgetHistory({
  month,
  entries,
  logs,
  changes,
  currency,
  privacyMode,
}: {
  month: string;
  entries: BudgetEntry[];
  logs: Map<string, BudgetLog[]>;
  changes: BudgetChange[];
  currency: string;
  privacyMode: boolean;
}) {
  const [view, setView] = useState<View>('all');
  const history = useMemo(() => buildHistory(entries, logs, changes), [entries, logs, changes]);

  const money = (value: number) =>
    maskIfPrivate(formatCurrency(Math.abs(value), currency, { decimals: 0 }), privacyMode);
  /** Negative amounts in a column are corrections or deductions; they say so. */
  const signed = (value: number) => (value < 0 ? `−${money(value)}` : money(value));

  // The filter narrows lines, and each day's figures follow what is shown.
  const days = useMemo(() => {
    if (view === 'all') return history.days;
    return history.days
      .map((day) => {
        const lines = day.lines.filter((l) => l.side === view);
        return {
          ...day,
          lines,
          credit: view === 'credit' ? day.credit : 0,
          debit: view === 'debit' ? day.debit : 0,
        };
      })
      .filter((day) => day.lines.length > 0);
  }, [history.days, view]);

  const count = (side: HistorySide) =>
    history.days.reduce((n, d) => n + d.lines.filter((l) => l.side === side).length, 0);

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <History className="size-4 text-text-muted" aria-hidden />
            History
          </span>
        }
        description={`Every amount in ${formatMonth(month)}, by the day the money moved.`}
        action={
          <div role="radiogroup" aria-label="Show" className="inline-flex rounded-xl border border-border bg-surface p-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={view === v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
                  view === v.id ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        }
      />
      <CardBody className="space-y-4 px-0 py-0">
        <div className="grid grid-cols-3 gap-4 border-b border-border px-5 py-4">
          <StatTile
            label="Credit — money in"
            value={signed(history.credit)}
            hint={`${count('credit')} ${count('credit') === 1 ? 'entry' : 'entries'}`}
          />
          <StatTile
            label="Debit — money out"
            value={signed(history.debit)}
            hint={`${count('debit')} ${count('debit') === 1 ? 'entry' : 'entries'}`}
          />
          <StatTile
            label="Net"
            value={`${history.net >= 0 ? '+' : '−'}${money(history.net)}`}
            hint="Credit minus debit"
          />
        </div>

        {days.length === 0 ? (
          <p className="px-5 pb-6 text-center text-sm text-text-muted">
            {history.days.length === 0
              ? `Nothing recorded in ${formatMonth(month)} yet. Amounts you type into the sheet appear here on the day you enter them.`
              : `No ${view === 'credit' ? 'money in' : 'money out'} recorded this month.`}
          </p>
        ) : (
          <div className="pb-2">
            {/* Column headings for the two money columns; on a phone the
                columns fold into one signed amount and these are hidden. */}
            <div className="hidden grid-cols-[1fr_8.5rem_8.5rem] gap-3 px-5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle sm:grid">
              <span>Date and item</span>
              <span className="text-right">Debit</span>
              <span className="text-right">Credit</span>
            </div>
            {days.map((day) => (
              <DayBlock
                key={day.key}
                day={day}
                month={month}
                money={money}
                signed={signed}
              />
            ))}
          </div>
        )}

        <p className="border-t border-border px-5 py-3 text-[11px] text-text-subtle">
          Amounts typed into the sheet are dated the day you type them; raising a figure later adds
          the difference on that day. To record separate payments with their own dates, use a row’s
          log (the list icon beside its amount).
        </p>
      </CardBody>
    </Card>
  );
}

function DayBlock({
  day,
  month,
  money,
  signed,
}: {
  day: HistoryDay;
  month: string;
  money: (value: number) => string;
  signed: (value: number) => string;
}) {
  const undated = day.key === 'undated';

  return (
    <section aria-label={undated ? 'Not dated' : dayLabel(day.timestamp as number)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 bg-surface-sunken/70 px-5 py-1.5">
        <h3 className="text-xs font-semibold text-text">
          {undated ? 'Not dated' : dayLabel(day.timestamp as number)}
        </h3>
        <p className="nums text-[11px] text-text-subtle">
          {day.credit !== 0 ? (
            <span className="text-positive">in {signed(day.credit)}</span>
          ) : null}
          {day.credit !== 0 && day.debit !== 0 ? ' · ' : null}
          {day.debit !== 0 ? <span>out {signed(day.debit)}</span> : null}
        </p>
      </header>
      {undated ? (
        <p className="px-5 pt-2 text-[11px] text-text-muted">
          These amounts have no date on record — typed before the history existed, typed into a past
          month, or copied from last month. Give one a date and it moves to that day.
        </p>
      ) : null}
      <ul className="divide-y divide-border/50">
        {day.lines.map((line) => (
          <LineRow key={line.id} line={line} month={month} money={money} signed={signed} />
        ))}
      </ul>
    </section>
  );
}

function LineRow({
  line,
  month,
  money,
  signed,
}: {
  line: HistoryLine;
  month: string;
  money: (value: number) => string;
  signed: (value: number) => string;
}) {
  const credit = line.side === 'credit';
  const amountClass = cn('nums text-sm', credit ? 'text-positive' : 'text-text');

  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-2 sm:grid-cols-[1fr_8.5rem_8.5rem]">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: line.accent }} aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm text-text">
            {line.label}
            {line.kind === 'deduction' ? (
              <span className="ml-1.5 text-[11px] text-text-subtle">withheld</span>
            ) : null}
          </p>
          {line.detail ? <p className="truncate text-[11px] text-text-muted">{line.detail}</p> : null}
          {line.datable && line.itemId ? <SetDate month={month} itemId={line.itemId} /> : null}
        </div>
      </div>

      {/* Phone: one signed amount. */}
      <span className={cn(amountClass, 'text-right sm:hidden')}>
        {credit ? (line.amount < 0 ? '−' : '+') : line.amount < 0 ? '+' : '−'}
        {money(line.amount)}
      </span>

      {/* Wider: the two columns of a statement. */}
      <span className={cn(amountClass, 'hidden text-right sm:block')}>
        {credit ? null : (
          <>
            <span className="sr-only">Debit </span>
            {signed(line.amount)}
          </>
        )}
      </span>
      <span className={cn(amountClass, 'hidden text-right sm:block')}>
        {credit ? (
          <>
            <span className="sr-only">Credit </span>
            {signed(line.amount)}
          </>
        ) : null}
      </span>
    </li>
  );
}

/** Inline date picker that moves an undated typed amount onto a day. */
function SetDate({ month, itemId }: { month: string; itemId: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => defaultDate(month));
  const [saving, setSaving] = useState(false);
  const { min, max } = monthBounds(month);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
      >
        <CalendarPlus className="size-3" aria-hidden />
        Set date
      </button>
    );
  }

  async function save() {
    if (!value) return;
    setSaving(true);
    try {
      await dateUndatedAmount({ month, itemId, timestamp: timestampFromInput(value) });
    } finally {
      setSaving(false);
      setOpen(false);
    }
  }

  return (
    <div className="mt-1 flex items-center gap-1.5">
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Date the money moved"
        className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-text"
      />
      <button
        onClick={() => void save()}
        disabled={saving || !value}
        aria-label="Save date"
        className="rounded-md p-1 text-positive hover:bg-surface-raised disabled:opacity-50"
      >
        <Check className="size-3.5" />
      </button>
      <button
        onClick={() => setOpen(false)}
        aria-label="Cancel"
        className="rounded-md p-1 text-text-muted hover:bg-surface-raised"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
