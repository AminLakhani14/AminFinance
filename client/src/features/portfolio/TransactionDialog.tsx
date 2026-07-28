/**
 * Add or edit a transaction.
 *
 * Binance-sourced rows are intentionally not editable here — they are
 * reconciled from the exchange on every sync, so a local edit would be silently
 * overwritten. The UI says so rather than letting the user lose work.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Transaction, AssetClass, TransactionType } from '@aminfinance/shared';
import { Button } from '@/components/ui/Button';
import { addTransaction, updateTransaction } from '@/lib/db';
import { cn } from '@/lib/utils';

interface TransactionDialogProps {
  open: boolean;
  onClose: () => void;
  /** Provide to edit; omit to create. */
  existing?: Transaction | null;
}

interface FormState {
  symbol: string;
  assetClass: AssetClass;
  type: TransactionType;
  quantity: string;
  price: string;
  fee: string;
  currency: string;
  date: string;
}

function toFormState(tx?: Transaction | null): FormState {
  if (!tx) {
    return {
      symbol: '',
      assetClass: 'stock',
      type: 'buy',
      quantity: '',
      price: '',
      fee: '0',
      currency: 'PKR',
      date: new Date().toISOString().slice(0, 10),
    };
  }
  return {
    symbol: tx.symbol,
    assetClass: tx.assetClass,
    type: tx.type,
    quantity: String(tx.quantity),
    price: String(tx.price),
    fee: String(tx.fee),
    currency: tx.currency,
    date: new Date(tx.timestamp).toISOString().slice(0, 10),
  };
}

export function TransactionDialog({ open, onClose, existing }: TransactionDialogProps) {
  const [form, setForm] = useState<FormState>(() => toFormState(existing));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(toFormState(existing));
      setError(null);
    }
  }, [open, existing]);

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

  const isBinanceSourced = existing?.source === 'binance';

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Crypto is quoted in USDT; stocks on PSX in PKR. Keep the currency
      // honest as the class changes so the maths downstream is right.
      if (key === 'assetClass') {
        next.currency = value === 'crypto' ? 'USDT' : 'PKR';
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const quantity = Number(form.quantity);
    const price = Number(form.price);
    const fee = Number(form.fee || '0');

    if (!form.symbol.trim()) return setError('Symbol is required.');
    if (!Number.isFinite(quantity) || quantity <= 0) return setError('Quantity must be greater than zero.');
    if (!Number.isFinite(price) || price < 0) return setError('Price must be zero or greater.');
    if (!Number.isFinite(fee) || fee < 0) return setError('Fee must be zero or greater.');

    const timestamp = new Date(`${form.date}T00:00:00`).getTime();
    if (!Number.isFinite(timestamp)) return setError('Date is invalid.');

    setSaving(true);
    try {
      if (existing) {
        await updateTransaction(existing.id, {
          symbol: form.symbol.trim().toUpperCase(),
          assetClass: form.assetClass,
          type: form.type,
          quantity,
          price,
          fee,
          currency: form.currency,
          timestamp,
        });
      } else {
        await addTransaction({
          id: crypto.randomUUID(),
          symbol: form.symbol.trim().toUpperCase(),
          assetClass: form.assetClass,
          type: form.type,
          quantity,
          price,
          fee,
          currency: form.currency,
          timestamp,
          source: 'manual',
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the transaction.');
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
        aria-labelledby="tx-dialog-title"
        className="w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-xl sm:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="tx-dialog-title" className="text-base font-semibold text-text">
            {existing ? 'Edit transaction' : 'Add transaction'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-raised hover:text-text"
          >
            <X className="size-4" />
          </button>
        </div>

        {isBinanceSourced ? (
          <p className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text">
            This row came from Binance. Editing it locally will be overwritten on the
            next sync — adjust it on the exchange instead.
          </p>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Symbol">
              <input
                value={form.symbol}
                onChange={(e) => update('symbol', e.target.value)}
                placeholder={form.assetClass === 'crypto' ? 'BTCUSDT' : 'FFC'}
                className={inputClass}
                autoFocus
              />
            </Field>
            <Field label="Type">
              <select
                value={form.assetClass}
                onChange={(e) => update('assetClass', e.target.value as AssetClass)}
                className={inputClass}
              >
                <option value="stock">PSX stock</option>
                <option value="crypto">Crypto</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Side">
              <select
                value={form.type}
                onChange={(e) => update('type', e.target.value as TransactionType)}
                className={inputClass}
              >
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
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

          <div className="grid grid-cols-3 gap-3">
            <Field label="Quantity">
              <input
                type="number"
                step="any"
                min="0"
                value={form.quantity}
                onChange={(e) => update('quantity', e.target.value)}
                className={cn(inputClass, 'nums')}
              />
            </Field>
            <Field label="Price">
              <input
                type="number"
                step="any"
                min="0"
                value={form.price}
                onChange={(e) => update('price', e.target.value)}
                className={cn(inputClass, 'nums')}
              />
            </Field>
            <Field label="Fee">
              <input
                type="number"
                step="any"
                min="0"
                value={form.fee}
                onChange={(e) => update('fee', e.target.value)}
                className={cn(inputClass, 'nums')}
              />
            </Field>
          </div>

          <p className="text-xs text-text-subtle">
            Price and fee are in <span className="font-medium text-text-muted">{form.currency}</span>.
            Fees are included in cost basis.
          </p>

          {error ? (
            <p className="rounded-lg bg-negative/10 px-3 py-2 text-xs text-negative">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : existing ? 'Save changes' : 'Add transaction'}
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
