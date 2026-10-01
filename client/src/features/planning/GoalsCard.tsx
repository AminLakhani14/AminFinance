/**
 * Savings goals with honest dates.
 *
 * Projections run off the *dependable* surplus, and goals are funded in
 * priority order rather than in parallel. Both choices make the dates later
 * than a naive tracker would show them, which is the point: a goal tracker
 * that quietly assumes every goal gets the full surplus is optimistic by
 * however many goals exist, and one that plans against the median slips half
 * the time by construction.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Target, Trash2 } from 'lucide-react';
import type { Goal } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { useAppSelector } from '@/app/hooks';
import { deleteGoal, putGoal } from '@/lib/db';
import { useConfirm } from '@/components/ui/useConfirm';
import { cn } from '@/lib/utils';
import { useGoals } from './useGoals';
import { useModalBehavior } from './useModalBehavior';

export function GoalsCard({ className }: { className?: string }) {
  const { rows, monthlyRate, isLoading, isEmpty, currency } = useGoals();
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);

  const money = (value: number) => maskIfPrivate(formatCurrency(value, currency), privacyMode);

  return (
    <Card className={className}>
      <CardHeader
        title="Goals"
        description={
          monthlyRate === null
            ? 'Projections need three months of budget history'
            : `Funded in order at ${money(monthlyRate)}/month`
        }
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" aria-hidden />
            Add
          </Button>
        }
      />
      <CardBody className="space-y-3">
        {isLoading ? (
          <div className="h-20 animate-pulse rounded-lg bg-surface-sunken" />
        ) : isEmpty ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <Target className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">No goals yet</p>
            <p className="mt-1 text-xs text-text-muted">
              Set a target and the app works out when your surplus gets you there.
            </p>
          </div>
        ) : (
          rows.map(({ goal, projection, allocated }) => {
            const progress =
              goal.targetAmount > 0
                ? Math.min(100, (goal.saved / goal.targetAmount) * 100)
                : 0;
            const met = projection.remaining <= 0;

            return (
              <div key={goal.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{goal.label}</p>
                    <p className="text-xs text-text-muted nums">
                      {money(goal.saved)} of {money(goal.targetAmount)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete ${goal.label}?`,
                        message: 'The goal and its progress will be removed.',
                        confirmLabel: 'Delete',
                        destructive: true,
                      });
                      if (ok) await deleteGoal(goal.id);
                    }}
                    className="shrink-0 rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-negative"
                    aria-label={`Delete ${goal.label}`}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>

                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className={cn('h-full rounded-full', met ? 'bg-positive' : 'bg-accent')}
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <p className="mt-2 text-xs text-text-muted">
                  {met ? (
                    <span className="text-positive">Funded.</span>
                  ) : allocated <= 0 ? (
                    monthlyRate === null
                      ? 'No rate yet — record a few budget months.'
                      : 'Waiting — the surplus is committed to goals above this one.'
                  ) : projection.monthsAtCurrentRate === null ? (
                    'Not reachable at the current rate.'
                  ) : (
                    <>
                      {projection.monthsAtCurrentRate} month
                      {projection.monthsAtCurrentRate === 1 ? '' : 's'} at {money(allocated)}
                      /mo
                      {projection.projectedDate !== null
                        ? ` · ${new Date(projection.projectedDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
                        : ''}
                    </>
                  )}
                </p>

                {/* Deadline verdict, when there is a deadline. */}
                {goal.targetDate !== null && !met ? (
                  <p
                    className={cn(
                      'mt-1 text-xs font-medium',
                      projection.onTrack === null
                        ? 'text-text-subtle'
                        : projection.onTrack
                          ? 'text-positive'
                          : 'text-negative',
                    )}
                  >
                    {projection.requiredMonthly !== null
                      ? `Needs ${money(projection.requiredMonthly)}/mo to hit ${new Date(goal.targetDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
                      : null}
                    {projection.monthsBehind !== null && projection.monthsBehind > 0
                      ? ` · ${projection.monthsBehind} month${projection.monthsBehind === 1 ? '' : 's'} behind`
                      : null}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </CardBody>

      {editing !== null ? (
        <GoalDialog
          goal={editing === 'new' ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {dialog}
    </Card>
  );
}

const fieldClass =
  'w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-text outline-none focus:border-accent';

function GoalDialog({
  goal,
  currency,
  onClose,
}: {
  goal: Goal | null;
  currency: string;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(goal?.label ?? '');
  const [target, setTarget] = useState(goal ? String(goal.targetAmount) : '');
  const [saved, setSaved] = useState(goal ? String(goal.saved) : '0');
  const [date, setDate] = useState(
    goal?.targetDate ? new Date(goal.targetDate).toISOString().slice(0, 10) : '',
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalBehavior(surfaceRef, onClose);

  const save = async () => {
    const targetAmount = Number(target);
    const savedAmount = Number(saved);
    if (!label.trim() || !Number.isFinite(targetAmount) || targetAmount <= 0) return;

    await putGoal({
      id: goal?.id ?? crypto.randomUUID(),
      label: label.trim(),
      targetAmount,
      saved: Number.isFinite(savedAmount) ? Math.max(0, savedAmount) : 0,
      currency: goal?.currency ?? currency,
      targetDate: date ? new Date(date).getTime() : null,
      createdAt: goal?.createdAt ?? Date.now(),
    });
    onClose();
  };

  // Portalled to <body>. `Card` carries `backdrop-blur-xl`, and a filter
  // establishes a containing block for fixed-position descendants — so a
  // dialog rendered inside the card would position against the card instead
  // of the viewport, which is exactly what it did.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={goal ? 'Edit goal' : 'Add goal'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        className="flex max-h-[90vh] w-full max-w-sm flex-col rounded-t-card border border-border bg-surface shadow-2xl sm:rounded-card"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-text">
            {goal ? 'Edit goal' : 'Add goal'}
          </h2>
        </div>
        {/* Scrolls rather than overflowing: this form is tall enough to clip
            on a short viewport, and the footer must stay reachable. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium text-text-muted">Goal</span>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Hajj fund"
              className={cn(fieldClass, 'mt-1')}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-text-muted">Target ({currency})</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="decimal"
              placeholder="1200000"
              className={cn(fieldClass, 'mt-1 nums')}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-text-muted">Already saved</span>
            <input
              value={saved}
              onChange={(e) => setSaved(e.target.value)}
              inputMode="decimal"
              className={cn(fieldClass, 'mt-1 nums')}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-text-muted">
              Target date (optional)
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={cn(fieldClass, 'mt-1')}
            />
            <span className="mt-1 block text-xs text-text-subtle">
              Leave blank to see when your surplus gets you there.
            </span>
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
