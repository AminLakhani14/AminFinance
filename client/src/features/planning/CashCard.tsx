/**
 * Cash accounts and debts — the manual half of the balance sheet.
 *
 * Every row carries the date its balance was last confirmed, and the card
 * leads with the stalest one. That is the honest presentation for data nobody
 * can sync: Pakistani banks have no retail API, so a balance is a number the
 * user typed on a day they remember, and showing it without that day invites
 * it to be read as live.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Banknote, Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  CashAccount,
  CashAccountKind,
  DebtRepayment,
  Liability,
} from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { useAppSelector } from '@/app/hooks';
import {
  db,
  deleteCashAccount,
  deleteLiability,
  putCashAccount,
  putLiability,
} from '@/lib/db';
import { debtProgress } from '@/lib/calc/debt';
import { useConfirm } from '@/components/ui/useConfirm';
import { BUDGET_ITEMS, budgetItem } from '@/lib/calc/budgetItems';
import { cn } from '@/lib/utils';
import { useWealth } from './useWealth';
import { useModalBehavior } from './useModalBehavior';

const KIND_LABELS: Record<CashAccountKind, string> = {
  bank: 'Bank account',
  'cash-on-hand': 'Cash on hand',
  'mobile-wallet': 'Mobile wallet',
  stablecoin: 'Stablecoin',
  'savings-certificate': 'Savings certificate',
  other: 'Other',
};

/** Days since a balance was confirmed, past which the UI nudges. */
const STALE_DAYS = 30;

/**
 * Sheet rows a debt can be paid from.
 *
 * Restricted to the `debt` category rather than offering all eighty items: a
 * debt paid from the "Groceries" row is a mis-link, and the resulting silent
 * balance drop would be hard to trace back.
 */
const REPAYMENT_ITEMS = BUDGET_ITEMS.filter((item) => item.category === 'debt');

function daysAgo(at: number, now = Date.now()): number {
  return Math.floor((now - at) / 86_400_000);
}

export function CashCard({ className }: { className?: string }) {
  const { accounts, liabilities, cash, debts, currency, isLoading } = useWealth();
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<CashAccount | 'new' | null>(null);
  const [editingDebt, setEditingDebt] = useState<Liability | 'new' | null>(null);

  const money = (value: number, code = currency) =>
    maskIfPrivate(formatCurrency(value, code), privacyMode);

  return (
    <Card className={className}>
      <CardHeader
        title="Cash & debts"
        description="Balances the portfolio cannot price — entered and confirmed by you"
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" aria-hidden />
            Add
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {isLoading ? (
          <div className="h-20 animate-pulse rounded-lg bg-surface-sunken" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-text-muted">Total cash</p>
                <p className="mt-1 text-xl font-semibold text-text nums">{money(cash)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-text-muted">Total debt</p>
                <p
                  className={cn(
                    'mt-1 text-xl font-semibold nums',
                    debts > 0 ? 'text-negative' : 'text-text',
                  )}
                >
                  {money(debts)}
                </p>
              </div>
            </div>

            {accounts.length === 0 && liabilities.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <Banknote className="mx-auto size-5 text-text-subtle" aria-hidden />
                <p className="mt-2 text-sm text-text">No cash recorded</p>
                <p className="mt-1 text-xs text-text-muted">
                  Your bank balance is zakatable and counts toward your emergency
                  runway, but nothing else in the app knows about it.
                </p>
              </div>
            ) : null}

            {accounts.length > 0 ? (
              <ul className="space-y-1.5 border-t border-border pt-3">
                {accounts.map((account) => {
                  const age = daysAgo(account.asOf);
                  return (
                    <li key={account.id} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text">{account.label}</p>
                        <p className="truncate text-xs text-text-subtle">
                          {KIND_LABELS[account.kind]}
                          {!account.liquid ? ' · not liquid' : ''}
                          {account.excludeFromZakat ? ' · outside zakat' : ''}
                          {age > STALE_DAYS ? ` · confirmed ${age}d ago` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-sm font-medium text-text nums">
                          {money(account.balance, account.currency)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditing(account)}
                          className="rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-text"
                          aria-label={`Edit ${account.label}`}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete ${account.label}?`,
                              message:
                                'This balance will stop counting toward zakat and your emergency runway.',
                              confirmLabel: 'Delete',
                              destructive: true,
                            });
                            if (ok) await deleteCashAccount(account.id);
                          }}
                          className="rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-negative"
                          aria-label={`Delete ${account.label}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <div className="flex items-center justify-between border-t border-border pt-3">
              <p className="text-xs font-medium text-text-muted">Debts</p>
              <Button size="sm" variant="ghost" onClick={() => setEditingDebt('new')}>
                <Plus className="size-3.5" aria-hidden />
                Add debt
              </Button>
            </div>

            {liabilities.length > 0 ? (
              <ul className="space-y-1.5">
                {liabilities.map((debt) => (
                  <li key={debt.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">{debt.label}</p>
                      <p className="truncate text-xs text-text-subtle">
                        {debt.linkedItemId
                          ? `Paid from ${budgetItem(debt.linkedItemId)?.label ?? debt.linkedItemId}`
                          : debt.deductibleFromZakat
                            ? 'Deducted from zakat base'
                            : 'Not deducted from zakat'}
                        {debt.annualRatePercent
                          ? ` · ${debt.annualRatePercent}%`
                          : debt.linkedItemId
                            ? ' · interest-free'
                            : ''}
                      </p>
                      <DebtProgressLine debt={debt} currency={currency} />
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-sm font-medium text-negative nums">
                        {money(debt.balance, debt.currency)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingDebt(debt)}
                        className="rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-text"
                        aria-label={`Edit ${debt.label}`}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete ${debt.label}?`,
                            message: 'It will stop reducing your zakat base and net worth.',
                            confirmLabel: 'Delete',
                            destructive: true,
                          });
                          if (ok) await deleteLiability(debt.id);
                        }}
                        className="rounded p-1 text-text-subtle hover:bg-surface-raised hover:text-negative"
                        aria-label={`Delete ${debt.label}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-subtle">
                None recorded. Short-term debts reduce your zakat base.
              </p>
            )}
          </>
        )}
      </CardBody>

      {editing !== null ? (
        <CashDialog
          account={editing === 'new' ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editingDebt !== null ? (
        <LiabilityDialog
          liability={editingDebt === 'new' ? null : editingDebt}
          currency={currency}
          onClose={() => setEditingDebt(null)}
        />
      ) : null}
      {dialog}
    </Card>
  );
}

/**
 * Progress and a clear date for a linked debt.
 *
 * Only rendered for a linked debt: an unlinked one has no repayment history,
 * so a bar showing 0% would report "no progress" on a loan that may be nearly
 * paid off outside the app.
 */
function DebtProgressLine({ debt, currency }: { debt: Liability; currency: string }) {
  const repayments = useLiveQuery(
    (): Promise<DebtRepayment[]> =>
      debt.linkedItemId
        ? db.debtRepayments.where('liabilityId').equals(debt.id).toArray()
        : Promise.resolve([]),
    [debt.id, debt.linkedItemId],
  );

  if (!debt.linkedItemId || repayments === undefined || repayments.length === 0) {
    return null;
  }

  const progress = debtProgress(debt, repayments);

  return (
    <div className="mt-1">
      <div className="h-1 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn(
            'h-full rounded-full',
            progress.balance <= 0 ? 'bg-positive' : 'bg-accent',
          )}
          style={{ width: `${progress.percentPaid}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-text-subtle">
        {progress.balance <= 0 ? (
          <span className="text-positive">Cleared.</span>
        ) : progress.growing ? (
          <span className="text-negative">
            Payments are below the monthly interest — this debt is growing.
          </span>
        ) : (
          <>
            {formatCurrency(progress.paidOff, currency)} paid off
            {progress.monthsRemaining !== null
              ? ` · ${progress.monthsRemaining} month${progress.monthsRemaining === 1 ? '' : 's'} left`
              : ''}
            {progress.interestPaid > 0
              ? ` · ${formatCurrency(progress.interestPaid, currency)} interest`
              : ''}
          </>
        )}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

const fieldClass =
  'w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-text outline-none focus:border-accent';

function CashDialog({
  account,
  currency,
  onClose,
}: {
  account: CashAccount | null;
  currency: string;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(account?.label ?? '');
  const [kind, setKind] = useState<CashAccountKind>(account?.kind ?? 'bank');
  const [balance, setBalance] = useState(account ? String(account.balance) : '');
  const [liquid, setLiquid] = useState(account?.liquid ?? true);
  const [excludeFromZakat, setExclude] = useState(account?.excludeFromZakat ?? false);

  const save = async () => {
    const parsed = Number(balance);
    if (!label.trim() || !Number.isFinite(parsed)) return;
    await putCashAccount({
      id: account?.id ?? crypto.randomUUID(),
      label: label.trim(),
      kind,
      balance: parsed,
      currency: account?.currency ?? currency,
      // Saving *is* confirming: the user just looked at the balance and typed
      // it, so the timestamp comes from the write and is never a form field.
      asOf: Date.now(),
      liquid,
      excludeFromZakat,
    });
    onClose();
  };

  return (
    <Modal title={account ? 'Edit account' : 'Add cash account'} onClose={onClose} onSave={save}>
      <label className="block">
        <span className="text-xs font-medium text-text-muted">Label</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Meezan current account"
          className={cn(fieldClass, 'mt-1')}
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-text-muted">Type</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as CashAccountKind)}
          className={cn(fieldClass, 'mt-1')}
        >
          {Object.entries(KIND_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-text-muted">Balance ({currency})</span>
        <input
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className={cn(fieldClass, 'mt-1 nums')}
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={liquid}
          onChange={(e) => setLiquid(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-text-muted">
          <span className="font-medium text-text">Reachable in an emergency</span> —
          counts toward your runway. Uncheck for a locked certificate.
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={excludeFromZakat}
          onChange={(e) => setExclude(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-text-muted">
          <span className="font-medium text-text">Not mine</span> — held for someone
          else, so it is left out of the zakat base.
        </span>
      </label>
    </Modal>
  );
}

function LiabilityDialog({
  liability,
  currency,
  onClose,
}: {
  liability: Liability | null;
  currency: string;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(liability?.label ?? '');
  const [balance, setBalance] = useState(liability ? String(liability.balance) : '');
  const [deductible, setDeductible] = useState(liability?.deductibleFromZakat ?? true);
  const [linkedItemId, setLinkedItemId] = useState(liability?.linkedItemId ?? '');
  const [rate, setRate] = useState(
    liability?.annualRatePercent !== undefined ? String(liability.annualRatePercent) : '',
  );

  const save = async () => {
    const parsed = Number(balance);
    if (!label.trim() || !Number.isFinite(parsed)) return;

    const parsedRate = Number(rate);
    const hasRate = rate.trim() !== '' && Number.isFinite(parsedRate) && parsedRate > 0;

    await putLiability({
      id: liability?.id ?? crypto.randomUUID(),
      label: label.trim(),
      balance: Math.abs(parsed),
      currency: liability?.currency ?? currency,
      asOf: Date.now(),
      deductibleFromZakat: deductible,
      // Preserved across edits so progress stays truthful. Set from the
      // opening balance on creation; on a later edit the user is correcting
      // the *current* balance, which must not silently redefine the original.
      originalBalance:
        liability?.originalBalance ?? (liability ? liability.balance : Math.abs(parsed)),
      ...(linkedItemId ? { linkedItemId } : {}),
      ...(hasRate ? { annualRatePercent: parsedRate } : {}),
    });
    onClose();
  };

  return (
    <Modal title={liability ? 'Edit debt' : 'Add debt'} onClose={onClose} onSave={save}>
      <label className="block">
        <span className="text-xs font-medium text-text-muted">Label</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Car loan"
          className={cn(fieldClass, 'mt-1')}
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-text-muted">
          Outstanding principal ({currency})
        </span>
        <input
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className={cn(fieldClass, 'mt-1 nums')}
        />
        <span className="mt-1 block text-xs text-text-subtle">
          The amount still owed, not the monthly instalment.
        </span>
      </label>
      {/* The link. This is what turns a static principal into a debt that
          actually shrinks as it is paid. */}
      <label className="block">
        <span className="text-xs font-medium text-text-muted">Paid from</span>
        <select
          value={linkedItemId}
          onChange={(e) => setLinkedItemId(e.target.value)}
          className={cn(fieldClass, 'mt-1')}
        >
          <option value="">Not linked — I track it myself</option>
          {REPAYMENT_ITEMS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-text-subtle">
          Link it to a row in your monthly expenses and whatever you record there
          comes off this balance automatically.
        </span>
      </label>

      <label className="block">
        <span className="text-xs font-medium text-text-muted">
          Interest rate (leave blank if none)
        </span>
        <div className="mt-1 flex items-center gap-2">
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={cn(fieldClass, 'nums')}
          />
          <span className="text-sm text-text-muted">% / year</span>
        </div>
        <span className="mt-1 block text-xs text-text-subtle">
          Blank means interest-free, so the whole payment reduces the debt — right
          for a family loan. With a rate, part of each payment is interest and does
          not touch the balance.
        </span>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={deductible}
          onChange={(e) => setDeductible(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-text-muted">
          <span className="font-medium text-text">Deduct from zakat base</span> — the
          common position is that only debts due within the year reduce it, so a
          long-term mortgage is usually left out.
        </span>
      </label>
    </Modal>
  );
}

/**
 * Minimal modal shell, matching the app's existing dialog treatment.
 *
 * Portalled to `<body>` rather than rendered in place. `Card` carries
 * `backdrop-blur-xl`, and a CSS filter establishes a containing block for
 * fixed-position descendants — so a dialog rendered inside the card
 * positions against the card's box instead of the viewport. The app's other
 * dialogs avoid this by being mounted at page level; a portal makes it
 * correct wherever the component happens to sit.
 */
function Modal({
  title,
  children,
  onClose,
  onSave,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalBehavior(surfaceRef, onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        className="flex max-h-[90vh] w-full max-w-sm flex-col rounded-t-card border border-border bg-surface shadow-2xl sm:rounded-card"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onSave()}>
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
