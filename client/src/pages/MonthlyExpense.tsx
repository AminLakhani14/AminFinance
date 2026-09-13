/**
 * Monthly budget: what came in, where it went, what was left.
 *
 * The page answers three questions in that order, top to bottom — the KPI row
 * is the answer, the breakdown is the explanation, the ledger is the evidence.
 * Everything is derived from the entries in IndexedDB on read; no total is
 * stored, so no total can go stale.
 */
import { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Minus,
  Pencil,
  Trash2,
  Repeat,
  CopyPlus,
} from 'lucide-react';
import type {
  BudgetCategory,
  BudgetEntry,
  BudgetEntryKind,
} from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatTile } from '@/components/ui/StatTile';
import { DonutChart } from '@/components/charts/DonutChart';
import { useConfirm } from '@/components/ui/useConfirm';
import { useAppSelector } from '@/app/hooks';
import { useBudget } from '@/features/budget/useBudget';
import { BudgetEntryDialog } from '@/features/budget/BudgetEntryDialog';
import { CategoryBreakdown } from '@/features/budget/CategoryBreakdown';
import { BudgetSheet } from '@/features/budget/BudgetSheet';
import { ExportMenu } from '@/features/budget/ExportMenu';
import { SavingsTrend } from '@/features/budget/SavingsTrend';
import { buildColorMap } from '@/components/charts/palette';
import { carryForwardRecurring, deleteBudgetEntry } from '@/lib/db';
import {
  categoryLabel,
  currentMonth,
  formatMonth,
  shiftMonth,
} from '@/lib/calc/budget';
import {
  formatCurrency,
  formatDate,
  formatPercent,
  maskIfPrivate,
} from '@/lib/format';
import { cn } from '@/lib/utils';

export function MonthlyExpense() {
  const [month, setMonth] = useState(() => currentMonth());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState<BudgetEntryKind>('expense');
  const [editing, setEditing] = useState<BudgetEntry | null>(null);
  const [carryNotice, setCarryNotice] = useState<string | null>(null);

  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  const { confirm, dialog } = useConfirm();

  const previousMonth = useMemo(() => shiftMonth(month, -1), [month]);
  const {
    entries,
    summary,
    expenseCategories,
    incomeCategories,
    trend,
    previous,
    isLoading,
    itemAmounts,
    currency,
  } = useBudget(month, previousMonth);

  // Colour is assigned by category identity, so a slice keeps its hue whether
  // it ranks first or fifth, and matches its row in the list beside it.
  const expenseColors = useMemo(
    () => buildColorMap(expenseCategories.map((c) => c.category)),
    [expenseCategories],
  );

  const donutData = useMemo(
    () => expenseCategories.map((c) => ({ symbol: c.category, value: c.amount })),
    [expenseCategories],
  );

  // Entries not backed by a sheet row — the sheet renders its own, so listing
  // them again below would show every amount twice.
  const extraEntries = useMemo(
    () => entries.filter((e) => !e.itemId),
    [entries],
  );

  // Charts appear once this month has any figures, rather than waiting on the
  // whole book: a fresh user who fills in September should see it immediately.
  const hasActivity = summary.income > 0 || summary.expenses > 0;

  const isCurrentMonth = month === currentMonth();
  const money = (value: number, decimals = 0) =>
    maskIfPrivate(formatCurrency(value, currency, { decimals }), privacyMode);

  function openAdd(kind: BudgetEntryKind) {
    setEditing(null);
    setDialogKind(kind);
    setDialogOpen(true);
    setCarryNotice(null);
  }

  function openEdit(entry: BudgetEntry) {
    setEditing(entry);
    setDialogKind(entry.kind);
    setDialogOpen(true);
    setCarryNotice(null);
  }

  async function handleDelete(entry: BudgetEntry) {
    const ok = await confirm({
      title: 'Delete entry?',
      message: `This removes ${formatCurrency(entry.amount, currency)} of ${categoryLabel(
        entry.category,
      ).toLowerCase()} from ${formatDate(entry.timestamp)}. The month's totals are recalculated from what remains.`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) await deleteBudgetEntry(entry.id);
  }

  async function handleCarryForward() {
    const copied = await carryForwardRecurring(previousMonth, month);
    setCarryNotice(
      copied === 0
        ? `Nothing to copy — ${formatMonth(previousMonth)} has no amounts that aren't already filled in here.`
        : `Copied ${copied} ${copied === 1 ? 'amount' : 'amounts'} from ${formatMonth(previousMonth)}. Adjust anything that changed.`,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text">
            Monthly expenses
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            What you earn, where it goes, and what you keep.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Month stepper. The label is a button back to "today" so a user who
              has paged into last March has a one-click way home. */}
          <div className="flex items-center rounded-xl border border-border bg-surface-raised/60">
            <button
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Previous month"
              className="rounded-l-xl p-2 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={() => setMonth(currentMonth())}
              disabled={isCurrentMonth}
              title={isCurrentMonth ? undefined : 'Jump to this month'}
              className="min-w-[9.5rem] px-2 text-sm font-medium text-text disabled:cursor-default"
            >
              {formatMonth(month)}
            </button>
            <button
              onClick={() => setMonth(shiftMonth(month, 1))}
              aria-label="Next month"
              className="rounded-r-xl p-2 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <ExportMenu
            month={month}
            monthLabel={formatMonth(month)}
            currency={currency}
          />
          <Button variant="secondary" onClick={() => openAdd('expense')}>
            <Plus className="size-4" />
            Add entry
          </Button>
        </div>
      </div>

      {/* KPI row — four numbers that answer the page's question outright. */}
      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Income"
            value={money(summary.income)}
            delta={deltaPercent(summary.income, previous.income)}
            deltaLabel={deltaLabel(summary.income, previous.income)}
            // Naming the gross and the deduction makes clear that the headline
            // figure is take-home, rather than leaving the user to wonder why
            // it does not match the salary they typed.
            hint={
              summary.deductions > 0
                ? `take-home · ${money(summary.grossIncome)} less ${money(summary.deductions)} tax`
                : `in ${formatMonth(month)}`
            }
          />
          <StatTile
            label="Spent"
            value={money(summary.expenses)}
            // A rise in spending is not a gain, so the sign is inverted: more
            // spending renders as the negative direction.
            delta={invert(deltaPercent(summary.expenses, previous.expenses))}
            deltaLabel={deltaLabel(summary.expenses, previous.expenses)}
            hint={`across ${expenseCategories.length} ${
              expenseCategories.length === 1 ? 'category' : 'categories'
            }`}
          />
          <StatTile
            label="Saved"
            value={money(summary.saved)}
            hint={
              summary.saved < 0
                ? 'You spent more than you earned'
                : 'Income minus spending'
            }
          />
          <StatTile
            label="Savings rate"
            value={
              summary.savingsRate === null
                ? '—'
                : `${summary.savingsRate.toFixed(1)}%`
            }
            hint={
              summary.savingsRate === null
                ? 'Add income to calculate'
                : `of every ${formatCurrency(100, currency, { decimals: 0 })} earned`
            }
          />
        </CardBody>
      </Card>

      {/* The sheet is the primary surface. Its cards are standalone, so this
          section is a bare heading plus the grid rather than one giant card
          wrapping eight more. */}
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-text">
              Fill in {formatMonth(month)}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              Type what you earned and paid. Leave anything you did not pay blank.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCarryForward}
            title={`Copy last month's amounts from ${formatMonth(previousMonth)}`}
          >
            <CopyPlus className="size-4" />
            Copy last month
          </Button>
        </div>

        {carryNotice ? (
          <p className="mb-3 rounded-lg border border-border bg-surface-raised/60 px-3 py-2 text-xs text-text-muted">
            {carryNotice}
          </p>
        ) : null}

        {isLoading ? (
          <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-56 animate-pulse rounded-card bg-surface-raised" />
            ))}
          </div>
        ) : (
          <BudgetSheet
            month={month}
            currency={currency}
            amounts={itemAmounts}
            privacyMode={privacyMode}
          />
        )}
      </section>

      {hasActivity ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Where it went"
                description={
                  summary.expenses > 0
                    ? `${money(summary.expenses)} across ${expenseCategories.length} ${
                        expenseCategories.length === 1 ? 'category' : 'categories'
                      }`
                    : 'No spending recorded this month'
                }
              />
              <CardBody>
                <CategoryBreakdown
                  data={expenseCategories}
                  currency={currency}
                  privacyMode={privacyMode}
                  colors={expenseColors}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Spending mix"
                description="Share of the month's outgoings"
              />
              <CardBody>
                {donutData.length > 0 ? (
                  <DonutChart
                    data={donutData}
                    currency={currency}
                    size={188}
                    labelFor={(key) => categoryLabel(key as BudgetCategory)}
                  />
                ) : (
                  <p className="py-6 text-center text-sm text-text-muted">
                    Nothing to allocate yet.
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Income vs spending"
              description={`Last ${trend.length} months. Click a month to open it.`}
            />
            <CardBody>
              <SavingsTrend
                data={trend}
                currency={currency}
                privacyMode={privacyMode}
                activeMonth={month}
                onSelectMonth={setMonth}
              />
            </CardBody>
          </Card>

          {incomeCategories.length > 1 ? (
            <Card>
              <CardHeader
                title="Income sources"
                description={`${money(summary.income)} in ${formatMonth(month)}`}
              />
              <CardBody>
                <CategoryBreakdown
                  data={incomeCategories}
                  currency={currency}
                  privacyMode={privacyMode}
                  colors={buildColorMap(incomeCategories.map((c) => c.category))}
                />
              </CardBody>
            </Card>
          ) : null}

          {/* Only entries that matched no sheet row. Anything the dialog could
              bind to an item now fills that box instead, so listing it here
              too would show the same money twice. */}
          <Card>
            <CardHeader
              title="One-off entries"
              description={
                extraEntries.length === 0
                  ? 'Anything that is not a standard monthly item'
                  : `${extraEntries.length} ${extraEntries.length === 1 ? 'entry' : 'entries'} outside the sheet above`
              }
              action={
                <Button variant="ghost" size="sm" onClick={() => openAdd('expense')}>
                  <Plus className="size-4" />
                  Add one-off
                </Button>
              }
            />
            <CardBody className="px-0 py-0">
              {extraEntries.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-text-muted">
                  Nothing here. Use this for one-time costs that are not part of
                  your usual month.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {extraEntries.map((entry) => (
                    <li
                      key={entry.id}
                      className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-raised/50"
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-lg',
                          entry.kind === 'income'
                            ? 'bg-positive/12 text-positive'
                            : 'bg-negative/12 text-negative',
                        )}
                        aria-hidden
                      >
                        {entry.kind === 'income' ? (
                          <Plus className="size-4" />
                        ) : (
                          <Minus className="size-4" />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-text">
                          <span className="truncate">
                            {entry.label ?? categoryLabel(entry.category)}
                          </span>
                          {entry.recurring ? (
                            <Repeat
                              className="size-3 shrink-0 text-text-subtle"
                              aria-label="Repeats monthly"
                            />
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-text-muted">
                          {formatDate(entry.timestamp)}
                          {entry.note ? ` · ${entry.note}` : ''}
                        </p>
                      </div>

                      {/* The sign does the work; colour only reinforces it. */}
                      <span
                        className={cn(
                          'shrink-0 nums text-sm font-medium',
                          entry.kind === 'income' ? 'text-positive' : 'text-text',
                        )}
                      >
                        {entry.kind === 'income' ? '+' : '−'}
                        {maskIfPrivate(
                          formatCurrency(entry.amount, currency),
                          privacyMode,
                        )}
                      </span>

                      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          onClick={() => openEdit(entry)}
                          aria-label={`Edit ${categoryLabel(entry.category)} entry`}
                          className="rounded-lg p-1.5 text-text-muted hover:bg-surface-raised hover:text-text"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(entry)}
                          aria-label={`Delete ${categoryLabel(entry.category)} entry`}
                          className="rounded-lg p-1.5 text-text-muted hover:bg-surface-raised hover:text-negative"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}

      <BudgetEntryDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existing={editing}
        defaultKind={dialogKind}
        month={month}
        currency={currency}
      />
      {dialog}
    </div>
  );
}

/**
 * Month-over-month change as a percent.
 *
 * `null` when the prior month was zero — "up from nothing" has no finite
 * percentage, and rendering ∞ or an arbitrary 100% would be a fabrication.
 */
function deltaPercent(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

function deltaLabel(current: number, prior: number): string | undefined {
  const delta = deltaPercent(current, prior);
  if (delta === null) return undefined;
  return `${formatPercent(delta)} vs last month`;
}

/** Flip the sign so "spending is up" reads as the negative direction. */
function invert(value: number | null): number | null {
  return value === null ? null : -value;
}
