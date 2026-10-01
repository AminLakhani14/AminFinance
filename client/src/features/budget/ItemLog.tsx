/**
 * The day-by-day log behind one sheet row.
 *
 * The amount box answers "what did Dining out cost this month". This answers
 * "when, and on what" — the running record you add to as the month happens,
 * rather than a single figure you reconcile at the end of it.
 *
 * It expands inside the row it belongs to instead of opening a dialog. A
 * dialog would cover the card the user is reading, and logging a coffee is a
 * two-second action that should not cost a context switch; keeping it in place
 * also means the row's total is visible updating as entries are added.
 *
 * Once a row has logs they own its total — the box above turns read-only and
 * shows their sum. That is enforced in `addBudgetLog` / `deleteBudgetLog`,
 * which re-derive the parent entry from the logs on every write.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { BudgetLog } from '@aminfinance/shared';
import { addBudgetLog, deleteBudgetLog, updateBudgetLog } from '@/lib/db';
import type { BudgetItem } from '@/lib/calc/budgetItems';
import { defaultDate, timestampFromInput, toDateInput } from '@/lib/calc/dateInput';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ItemLogProps {
  item: BudgetItem;
  month: string;
  currency: string;
  logs: BudgetLog[];
  privacyMode: boolean;
  accent: string;
}

/** "Sep 18" — the year is redundant inside a single month's sheet. */
function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function ItemLog({
  item,
  month,
  currency,
  logs,
  privacyMode,
  accent,
}: ItemLogProps) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => defaultDate(month));
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // The month can change under an open panel (the page's month arrows), and a
  // date left over from the previous month would log into the wrong one.
  useEffect(() => {
    setDate(defaultDate(month));
  }, [month]);

  // Opening the panel should land the caret where the user is about to type.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const context = { kind: item.kind, category: item.category };

  async function handleAdd() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;

    await addBudgetLog({
      month,
      itemId: item.id,
      kind: item.kind,
      category: item.category,
      amount: value,
      currency,
      timestamp: timestampFromInput(date),
      note,
    });

    // Date deliberately kept: logging several days at once is common, and
    // re-picking the same day for each would be the slowest part of the form.
    setAmount('');
    setNote('');
    amountRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleAdd();
    }
  }

  const canAdd = Number(amount) > 0;

  return (
    <div
      className="mb-2 ml-2.5 space-y-2 rounded-xl border border-border/70 bg-surface-raised/40 p-2.5"
      style={{ borderLeftColor: accent, borderLeftWidth: 2 }}
    >
      {/* Two lines, not one. Four controls across a card this narrow squeezed
          the amount box down to about two digits — and the amount is the one
          field that is always filled in. Amount and date share the first line;
          the optional note gets the second, beside the button it submits. */}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-text-subtle">
            {currency}
          </span>
          <input
            ref={amountRef}
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Amount"
            aria-label={`Amount spent on ${item.label}`}
            className="h-8 w-full rounded-lg border border-border/70 bg-surface pl-8 pr-2 text-right text-[13px] nums text-text transition-colors placeholder:text-text-subtle focus:border-border-strong focus:outline-none focus:ring-1"
            style={{ '--tw-ring-color': accent } as React.CSSProperties}
          />
        </div>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={`Date of this ${item.label} entry`}
          className="h-8 w-[8.5rem] shrink-0 rounded-lg border border-border/70 bg-surface px-2 text-[12px] nums text-text-muted transition-colors focus:border-border-strong focus:outline-none focus:ring-1"
          style={{ '--tw-ring-color': accent } as React.CSSProperties}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Note (optional)"
          aria-label={`Note for this ${item.label} entry`}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border/70 bg-surface px-2 text-[12px] text-text transition-colors placeholder:text-text-subtle focus:border-border-strong focus:outline-none focus:ring-1"
          style={{ '--tw-ring-color': accent } as React.CSSProperties}
        />

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={!canAdd}
          aria-label={`Add this ${item.label} entry`}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-all',
            canAdd
              ? 'text-white hover:brightness-110'
              : 'cursor-not-allowed bg-surface-raised text-text-subtle',
          )}
          style={canAdd ? { background: accent } : undefined}
        >
          <Plus className="size-3.5" />
          Add
        </button>
      </div>

      {logs.length === 0 ? (
        <p className="py-1 text-center text-[11px] text-text-subtle">
          No entries yet. Add what you spent and it will be listed here by date.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {logs.map((log) =>
            editingId === log.id ? (
              <EditRow
                key={log.id}
                log={log}
                item={item}
                currency={currency}
                accent={accent}
                context={context}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <li
                key={log.id}
                className="group/log flex items-center gap-2 py-1.5 text-[12px]"
              >
                <span className="w-11 shrink-0 nums text-text-subtle">
                  {shortDate(log.timestamp)}
                </span>

                <span className="min-w-0 flex-1 truncate text-text-muted">
                  {log.note ?? <span className="text-text-subtle">—</span>}
                </span>

                <span
                  className={cn(
                    'shrink-0 nums font-medium text-text',
                    privacyMode && 'blur-[5px]',
                  )}
                >
                  {formatCurrency(log.amount, currency, { decimals: 0 })}
                </span>

                {/* Confirm in place rather than via `window.confirm`: a native
                    dialog steals focus out of the card and reads as a system
                    error for what is a one-row undoable delete. */}
                {pendingDelete === log.id ? (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        void deleteBudgetLog(log.id, context);
                        setPendingDelete(null);
                      }}
                      aria-label={`Confirm deleting this ${item.label} entry`}
                      className="rounded p-1 text-negative transition-colors hover:bg-negative/12"
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(null)}
                      aria-label={`Keep this ${item.label} entry`}
                      className="rounded p-1 text-text-subtle transition-colors hover:bg-surface-raised hover:text-text"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  // Revealed on hover, but always present for keyboard and
                  // touch — `opacity` alone would leave them unreachable.
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/log:opacity-100">
                    <button
                      type="button"
                      onClick={() => setEditingId(log.id)}
                      aria-label={`Edit ${item.label} entry of ${formatCurrency(log.amount, currency, { decimals: 0 })}`}
                      className="rounded p-1 text-text-subtle transition-colors hover:bg-surface-raised hover:text-text"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(log.id)}
                      aria-label={`Delete ${item.label} entry of ${formatCurrency(log.amount, currency, { decimals: 0 })}`}
                      className="rounded p-1 text-text-subtle transition-colors hover:bg-negative/12 hover:text-negative"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

interface EditRowProps {
  log: BudgetLog;
  item: BudgetItem;
  currency: string;
  accent: string;
  context: { kind: BudgetItem['kind']; category: BudgetItem['category'] };
  onDone: () => void;
}

/**
 * One log row swapped for its editable fields.
 *
 * Editing in place rather than in a dialog for the same reason the add form is
 * inline — and because the surrounding rows stay visible, which is the context
 * that tells you whether the figure you are correcting is the right one.
 */
function EditRow({ log, item, currency, accent, context, onDone }: EditRowProps) {
  const [amount, setAmount] = useState(String(log.amount));
  const [date, setDate] = useState(toDateInput(new Date(log.timestamp)));
  const [note, setNote] = useState(log.note ?? '');

  async function save() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;

    await updateBudgetLog(
      log.id,
      {
        amount: value,
        timestamp: timestampFromInput(date),
        // `null`, not `undefined` — clearing the box must clear the stored
        // note rather than leave the old one in place.
        note: note.trim() || null,
      },
      context,
    );
    onDone();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-1.5 py-1.5">
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={`Date of the ${item.label} entry being edited`}
        className="h-7 shrink-0 rounded-lg border border-border/70 bg-surface px-1.5 text-[11px] nums text-text-muted focus:outline-none focus:ring-1"
        style={{ '--tw-ring-color': accent } as React.CSSProperties}
      />

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Note"
        aria-label={`Note of the ${item.label} entry being edited`}
        className="h-7 min-w-[5rem] flex-1 rounded-lg border border-border/70 bg-surface px-2 text-[11px] text-text placeholder:text-text-subtle focus:outline-none focus:ring-1"
        style={{ '--tw-ring-color': accent } as React.CSSProperties}
      />

      <input
        type="number"
        inputMode="decimal"
        step="any"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={`Amount of the ${item.label} entry being edited, in ${currency}`}
        autoFocus
        className="h-7 w-20 shrink-0 rounded-lg border border-border/70 bg-surface px-2 text-right text-[11px] nums text-text focus:outline-none focus:ring-1"
        style={{ '--tw-ring-color': accent } as React.CSSProperties}
      />

      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => void save()}
          aria-label={`Save changes to this ${item.label} entry`}
          className="rounded p-1 text-positive transition-colors hover:bg-positive/12"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDone}
          aria-label={`Cancel editing this ${item.label} entry`}
          className="rounded p-1 text-text-subtle transition-colors hover:bg-surface-raised hover:text-text"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  );
}
