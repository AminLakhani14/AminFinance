/**
 * Record money in or money out.
 *
 * One dialog for both kinds rather than two: the fields are identical apart
 * from the category list, and a single form means the user can fix a
 * mis-classified salary without deleting and re-entering it.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  BudgetCategory,
  BudgetEntry,
  BudgetEntryKind,
} from '@aminfinance/shared';
import { Button } from '@/components/ui/Button';
import { addBudgetEntry, updateBudgetEntry } from '@/lib/db';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  categoryLabel,
} from '@/lib/calc/budget';
import { itemForCategory } from '@/lib/calc/budgetItems';
import { cn } from '@/lib/utils';

interface BudgetEntryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Provide to edit; omit to create. */
  existing?: BudgetEntry | null;
  /** Kind to open on when creating. Ignored when editing. */
  defaultKind?: BudgetEntryKind;
  /** `YYYY-MM` the user is viewing — new entries default into it. */
  month: string;
  currency: string;
}

interface FormState {
  kind: BudgetEntryKind;
  category: BudgetCategory;
  amount: string;
  date: string;
  note: string;
  recurring: boolean;
}

/** Local `YYYY-MM-DD` for a date input — never `toISOString`, which shifts to UTC. */
function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Default date for a new entry.
 *
 * Today when the user is looking at the current month, otherwise the 1st of
 * the month on screen — entering a September expense while viewing September
 * should not silently file it under today's date in November.
 */
function defaultDate(month: string, now = new Date()): string {
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month === currentKey) return toDateInput(now);
  return `${month}-01`;
}

function toFormState(
  existing: BudgetEntry | null | undefined,
  defaultKind: BudgetEntryKind,
  month: string,
): FormState {
  if (!existing) {
    return {
      kind: defaultKind,
      category: defaultKind === 'income' ? 'salary' : 'groceries',
      amount: '',
      date: defaultDate(month),
      note: '',
      // Salary is the archetypal fixed monthly item, so income defaults on;
      // a one-off grocery run is the archetypal expense, so expense defaults off.
      recurring: defaultKind === 'income',
    };
  }
  return {
    kind: existing.kind,
    category: existing.category,
    amount: String(existing.amount),
    date: toDateInput(new Date(existing.timestamp)),
    note: existing.note ?? '',
    recurring: existing.recurring,
  };
}

export function BudgetEntryDialog({
  open,
  onClose,
  existing,
  defaultKind = 'expense',
  month,
  currency,
}: BudgetEntryDialogProps) {
  const [form, setForm] = useState<FormState>(() =>
    toFormState(existing, defaultKind, month),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(toFormState(existing, defaultKind, month));
      setError(null);
    }
  }, [open, existing, defaultKind, month]);

  // Close on Escape — a modal that traps the user is a bug.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const categories = form.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Switching kind invalidates the category — 'salary' is not a valid
      // expense. Reset to that kind's default rather than carrying it over.
      if (key === 'kind' && value !== f.kind) {
        next.category = value === 'income' ? 'salary' : 'groceries';
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return setError('Amount must be greater than zero.');
    }

    const timestamp = new Date(`${form.date}T00:00:00`).getTime();
    if (!Number.isFinite(timestamp)) return setError('Date is invalid.');

    const note = form.note.trim();

    setSaving(true);
    try {
      if (existing) {
        await updateBudgetEntry(existing.id, {
          kind: form.kind,
          category: form.category,
          amount,
          currency,
          timestamp,
          recurring: form.recurring,
          // Clearing the box must actually clear the stored text, so an empty
          // string is written rather than the key being omitted.
          note,
          label: note,
        });
      } else {
        // Bind to the matching sheet row when there is one, so the amount
        // lands in that box instead of counting only in the totals while the
        // form stays blank. `addBudgetEntry` merges into an existing value.
        const target = itemForCategory(form.kind, form.category);

        await addBudgetEntry({
          id: crypto.randomUUID(),
          kind: form.kind,
          category: form.category,
          amount,
          currency,
          timestamp,
          recurring: form.recurring,
          ...(target ? { itemId: target.id } : {}),
          ...(note ? { note, label: note } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the entry.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="budget-dialog-title"
        className="w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-xl sm:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="budget-dialog-title" className="text-base font-semibold text-text">
            {existing
              ? 'Edit entry'
              : form.kind === 'income'
                ? 'Add income'
                : 'Add expense'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-raised hover:text-text"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Kind is a segmented control, not a select — it is the one choice
              that changes the meaning of every other field, so it should stay
              visible rather than fold into a dropdown. */}
          <div
            role="radiogroup"
            aria-label="Entry type"
            className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface-raised/60 p-1"
          >
            {(['income', 'expense'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={form.kind === kind}
                onClick={() => update('kind', kind)}
                className={cn(
                  'h-8 rounded-lg text-sm font-medium transition-colors',
                  form.kind === kind
                    ? kind === 'income'
                      ? 'bg-positive/15 text-positive ring-1 ring-inset ring-positive/30'
                      : 'bg-negative/15 text-negative ring-1 ring-inset ring-negative/30'
                    : 'text-text-muted hover:bg-surface-raised hover:text-text',
                )}
              >
                {kind === 'income' ? 'Money in' : 'Money out'}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Amount (${currency})`}>
              <input
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => update('amount', e.target.value)}
                placeholder="0.00"
                className={cn(inputClass, 'nums')}
                autoFocus
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={form.date}
                onChange={(e) => update('date', e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) => update('category', e.target.value as BudgetCategory)}
              className={inputClass}
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(category)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="What was it?">
            <input
              value={form.note}
              onChange={(e) => update('note', e.target.value)}
              placeholder={
                form.kind === 'income' ? 'Eid bonus' : 'Car repair'
              }
              maxLength={120}
              className={inputClass}
            />
          </Field>

          <label className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-raised/50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={form.recurring}
              onChange={(e) => update('recurring', e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="text-xs">
              <span className="font-medium text-text">Repeats monthly</span>
              <span className="mt-0.5 block text-text-subtle">
                Marks it as a fixed item. Next month you can copy these forward in
                one click — nothing is posted automatically.
              </span>
            </span>
          </label>

          {error ? (
            <p className="rounded-lg bg-negative/10 px-3 py-2 text-xs text-negative">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : existing ? 'Save changes' : 'Add entry'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'h-9 w-full rounded-lg border border-border bg-surface-raised px-3 text-sm text-text';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      {children}
    </label>
  );
}
