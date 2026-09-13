/**
 * Broker position sync (PSX / JS InvestPro).
 *
 * PSX has no account API we can sign into, so stock positions are entered by
 * hand from the broker's app. What the broker reports is a *net* position —
 * "504 shares @ 156.06" — not the fills behind it, which is why this takes
 * quantity and average rate rather than individual trades.
 *
 * Saving replaces the manual stock book wholesale (see `replaceStockPositions`):
 * anything omitted here is treated as sold. That is the honest reading of a
 * broker holdings screen, which lists everything you own — but it means a
 * half-filled form silently closes positions, so the form is pre-loaded with
 * what is already stored and the destructive part is spelled out on the button.
 */
import { useState } from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { replaceStockPositions } from '@/lib/db';
import { usePortfolio } from './usePortfolio';

interface Row {
  key: string;
  symbol: string;
  quantity: string;
  averageCost: string;
}

const newRow = (): Row => ({
  key: crypto.randomUUID(),
  symbol: '',
  quantity: '',
  averageCost: '',
});

export function BrokerPositionsCard() {
  const { holdings, displayCurrency } = usePortfolio();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed from what is already stored, so saving an untouched form is a no-op
  // rather than a mass close-out.
  const current: Row[] =
    rows ??
    holdings
      .filter((h) => h.assetClass === 'stock')
      .map((h) => ({
        key: h.symbol,
        symbol: h.symbol,
        quantity: String(h.quantity),
        averageCost: h.averageCost.toFixed(2),
      }));

  const editing = current.length > 0 ? current : [newRow()];

  function update(key: string, patch: Partial<Row>) {
    setSaved(null);
    setRows(editing.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setError(null);
    setSaved(null);

    const filled = editing.filter(
      (r) => r.symbol.trim() !== '' || r.quantity.trim() !== '' || r.averageCost.trim() !== '',
    );

    const parsed: Array<{ symbol: string; quantity: number; averageCost: number; currency: string }> = [];
    for (const row of filled) {
      const symbol = row.symbol.trim().toUpperCase();
      const quantity = Number(row.quantity);
      const averageCost = Number(row.averageCost);

      if (!symbol) return setError('Every row needs a symbol.');
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return setError(`${symbol}: quantity must be a positive number.`);
      }
      if (!Number.isFinite(averageCost) || averageCost <= 0) {
        return setError(`${symbol}: average rate must be a positive number.`);
      }
      parsed.push({ symbol, quantity, averageCost, currency: 'PKR' });
    }

    const duplicate = parsed.find(
      (p, i) => parsed.findIndex((q) => q.symbol === p.symbol) !== i,
    );
    if (duplicate) return setError(`${duplicate.symbol} is listed twice.`);

    const { removed, added } = await replaceStockPositions(parsed);
    setRows(null);
    setSaved(
      `Saved ${added} stock position${added === 1 ? '' : 's'}` +
        (removed > added ? `; ${removed - added} closed out.` : '.'),
    );
  }

  return (
    <Card>
      <CardHeader
        title="Stock positions"
        description="Entered from your broker — PSX has no account API to sync."
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRows([...editing, newRow()])}
            aria-label="Add a position"
          >
            <Plus className="size-4" />
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <div className="hidden gap-3 px-1 text-xs font-medium text-text-subtle sm:grid sm:grid-cols-[1fr_1fr_1fr_auto]">
          <span>Symbol</span>
          <span>Shares</span>
          <span>Avg rate ({displayCurrency === 'PKR' ? 'PKR' : 'PKR'})</span>
          <span className="w-8" />
        </div>

        {editing.map((row) => (
          <div key={row.key} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              value={row.symbol}
              onChange={(e) => update(row.key, { symbol: e.target.value })}
              placeholder="FATIMA"
              aria-label="Symbol"
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm uppercase text-text placeholder:normal-case placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            <input
              value={row.quantity}
              onChange={(e) => update(row.key, { quantity: e.target.value })}
              placeholder="504"
              inputMode="decimal"
              aria-label="Shares"
              className="nums rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            <input
              value={row.averageCost}
              onChange={(e) => update(row.key, { averageCost: e.target.value })}
              placeholder="156.06"
              inputMode="decimal"
              aria-label="Average rate"
              className="nums rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSaved(null);
                setRows(editing.filter((r) => r.key !== row.key));
              }}
              aria-label={`Remove ${row.symbol || 'row'}`}
            >
              <Trash2 className="size-4 text-text-subtle" />
            </Button>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button variant="primary" size="sm" onClick={() => void handleSave()}>
            Save positions
          </Button>
          <span className="text-xs text-text-subtle">
            Replaces your stock book — anything not listed here is treated as sold.
          </span>
        </div>

        {error ? <p className="text-xs text-negative">{error}</p> : null}
        {saved ? (
          <p className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-text-muted">
            <Check className="mt-0.5 size-3.5 shrink-0 text-positive" />
            {saved}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
