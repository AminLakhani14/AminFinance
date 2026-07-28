/**
 * CSV import.
 *
 * The only path from a broker with no API — JS InvestPro included — into this
 * app. Accepts a file or pasted text, previews what it parsed before writing
 * anything, and reports per-row problems instead of failing the whole file.
 */
import { useRef, useState } from 'react';
import { X, Upload, FileText, TriangleAlert, Check } from 'lucide-react';
import type { Transaction } from '@aminfinance/shared';
import { Button } from '@/components/ui/Button';
import { parseCsv, type ParseResult } from '@/lib/csv';
import { importTransactions } from '@/lib/db';
import { formatQuantity, formatCurrency, formatDate } from '@/lib/format';

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Format sample.
 *
 * Deliberately uses placeholder tickers and round numbers. An earlier version
 * used real holdings, which made the sample indistinguishable from a partial
 * copy of the user's own portfolio — someone clicked it expecting their data
 * and silently imported three rows of sample instead.
 */
const TEMPLATE = `symbol,assetClass,type,quantity,price,fee,currency,date
EXAMPLE1,stock,buy,100,50,0,PKR,2026-01-15
EXAMPLE2,stock,buy,200,25,0,PKR,2026-02-20
ETHUSDT,crypto,buy,1.5,3000,0,USDT,2026-03-10`;

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  // Flag the sample explicitly — importing it silently is exactly the failure
  // this dialog had before.
  const isSample =
    parsed !== null && parsed.transactions.some((t) => t.symbol.startsWith('EXAMPLE'));

  function handleText(value: string) {
    setText(value);
    setImported(null);
    setParsed(value.trim() ? parseCsv(value) : null);
  }

  async function handleFile(file: File) {
    const content = await file.text();
    handleText(content);
  }

  async function handleImport() {
    if (!parsed || parsed.transactions.length === 0) return;
    setBusy(true);
    try {
      const added = await importTransactions(parsed.transactions);
      setImported(added);
    } finally {
      setBusy(false);
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
        aria-labelledby="import-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-2xl border border-border bg-surface shadow-xl sm:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="import-title" className="text-base font-semibold text-text">
            Import transactions
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-raised hover:text-text"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />

          {/* The file picker is the real path — make it unmistakably primary,
              and keep the format sample visually subordinate to it. */}
          <div className="rounded-lg border border-dashed border-border-strong bg-surface-sunken px-4 py-5 text-center">
            <Button variant="primary" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" />
              Choose CSV file
            </Button>
            <p className="mt-2 text-xs text-text-muted">
              Import your own data — e.g.{' '}
              <code className="rounded bg-surface px-1 py-0.5 font-mono">my-portfolio.csv</code>{' '}
              in the project folder.
            </p>
          </div>

          <button
            onClick={() => handleText(TEMPLATE)}
            className="inline-flex items-center gap-1.5 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            <FileText className="size-3.5" />
            Show the expected format (sample rows, not your data)
          </button>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-muted">
              …or paste CSV here
            </span>
            <textarea
              value={text}
              onChange={(e) => handleText(e.target.value)}
              rows={7}
              spellCheck={false}
              placeholder={TEMPLATE}
              className="w-full rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs text-text"
            />
          </label>

          <p className="text-xs text-text-subtle">
            Required columns: <code className="font-mono">symbol</code>,{' '}
            <code className="font-mono">quantity</code>, <code className="font-mono">price</code>.
            Optional: <code className="font-mono">assetClass</code>,{' '}
            <code className="font-mono">type</code>, <code className="font-mono">fee</code>,{' '}
            <code className="font-mono">currency</code>, <code className="font-mono">date</code>,{' '}
            <code className="font-mono">notes</code>. Common header names (qty, ticker, side,
            commission…) are recognised automatically.
          </p>

          {parsed && parsed.errors.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <TriangleAlert className="size-3.5" />
                {parsed.errors.length} row{parsed.errors.length === 1 ? '' : 's'} skipped
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {parsed.errors.slice(0, 5).map((err) => (
                  <li key={`${err.line}-${err.message}`} className="text-xs text-text-muted">
                    Line {err.line}: {err.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {isSample ? (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              This is the format sample, not your portfolio. Use{' '}
              <strong>Choose CSV file</strong> above to import your own data.
            </p>
          ) : null}

          {parsed && parsed.transactions.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium text-text-muted">
                Preview — {parsed.transactions.length} transaction
                {parsed.transactions.length === 1 ? '' : 's'}
              </p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken text-left text-text-muted">
                      <th className="px-3 py-2 font-medium">Symbol</th>
                      <th className="px-3 py-2 font-medium">Side</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.transactions.slice(0, 12).map((tx: Transaction) => (
                      <tr key={tx.id} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-1.5 font-medium text-text">
                          {tx.symbol}
                          <span className="ml-1.5 text-[10px] uppercase text-text-subtle">
                            {tx.assetClass}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-text-muted">{tx.type}</td>
                        <td className="px-3 py-1.5 text-right nums text-text-muted">
                          {formatQuantity(tx.quantity)}
                        </td>
                        <td className="px-3 py-1.5 text-right nums text-text-muted">
                          {formatCurrency(tx.price, tx.currency)}
                        </td>
                        <td className="px-3 py-1.5 text-text-muted nums">
                          {formatDate(tx.timestamp)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {imported !== null ? (
            <p className="flex items-center gap-2 rounded-lg bg-positive/10 px-3 py-2 text-sm text-text">
              <Check className="size-4 text-positive" />
              {imported > 0
                ? `Imported ${imported} transaction${imported === 1 ? '' : 's'}.`
                : 'Already imported — no new rows. Safe to re-run.'}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="ghost" onClick={onClose}>
            {imported !== null ? 'Done' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleImport()}
            disabled={busy || !parsed || parsed.transactions.length === 0}
          >
            {busy
              ? 'Importing…'
              : `Import ${parsed?.transactions.length ?? 0} transaction${
                  (parsed?.transactions.length ?? 0) === 1 ? '' : 's'
                }`}
          </Button>
        </div>
      </div>
    </div>
  );
}
