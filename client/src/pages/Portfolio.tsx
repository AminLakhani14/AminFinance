import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Upload, Download } from 'lucide-react';
import type { Transaction } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatTile } from '@/components/ui/StatTile';
import { HoldingsTable } from '@/features/portfolio/HoldingsTable';
import { TransactionDialog } from '@/features/portfolio/TransactionDialog';
import { ImportDialog } from '@/features/portfolio/ImportDialog';
import { toCsv, downloadCsv } from '@/lib/csv';
import { BinanceSyncCard } from '@/features/portfolio/BinanceSyncCard';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { useSparklines } from '@/features/portfolio/useCandleSeries';
import { deleteTransaction } from '@/lib/db';
import {
  formatCurrency,
  formatPercent,
  formatQuantity,
  formatDate,
  directionClass,
} from '@/lib/format';
import { cn } from '@/lib/utils';

export function Portfolio() {
  const { holdings, summary, transactions, convert, displayCurrency, isEmpty, quoteErrors } =
    usePortfolio();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const sparklines = useSparklines(holdings.map((h) => h.symbol));

  const recentTransactions = useMemo(
    () => [...transactions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 25),
    [transactions],
  );

  function openAdd() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(tx: Transaction) {
    setEditing(tx);
    setDialogOpen(true);
  }

  async function handleDelete(tx: Transaction) {
    const ok = window.confirm(
      `Delete this ${tx.type} of ${formatQuantity(tx.quantity)} ${tx.symbol}?\n\nThis cannot be undone.`,
    );
    if (ok) await deleteTransaction(tx.id);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text">Portfolio</h1>
          <p className="mt-1 text-sm text-text-muted">
            Holdings, transactions, and live profit &amp; loss.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" />
            Import CSV
          </Button>
          {transactions.length > 0 ? (
            <Button
              variant="ghost"
              onClick={() => downloadCsv('aminfinance-transactions.csv', toCsv(transactions))}
              title="Export as CSV — doubles as a backup"
            >
              <Download className="size-4" />
              Export
            </Button>
          ) : null}
          <Button variant="primary" onClick={openAdd}>
            <Plus className="size-4" />
            Add transaction
          </Button>
        </div>
      </div>

      {/* A KPI row, not a chart — the job here is "four numbers". */}
      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Total value"
            value={formatCurrency(summary.totalValue, displayCurrency, { compact: true })}
            delta={summary.dayChangePercent}
            deltaLabel={`${formatPercent(summary.dayChangePercent)} today`}
          />
          <StatTile
            label="Invested"
            value={formatCurrency(summary.totalCostBasis, displayCurrency, { compact: true })}
            hint={`${summary.holdingsCount} holding${summary.holdingsCount === 1 ? '' : 's'}`}
          />
          <StatTile
            label="Unrealised P/L"
            value={formatCurrency(summary.totalUnrealizedPnl, displayCurrency, { compact: true })}
            delta={summary.totalUnrealizedPnlPercent}
          />
          <StatTile
            label="Realised P/L"
            value={formatCurrency(summary.totalRealizedPnl, displayCurrency, { compact: true })}
            hint="From closed positions"
          />
        </CardBody>
      </Card>

      {Object.keys(quoteErrors).length > 0 ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text">
          Could not price: {Object.keys(quoteErrors).join(', ')}. Those rows show cost
          basis instead of market value.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="Holdings"
          description={isEmpty ? 'Nothing here yet.' : `${holdings.length} open positions`}
        />
        <CardBody className="p-0">
          <HoldingsTable
            holdings={holdings}
            sparklines={sparklines}
            convert={convert}
            displayCurrency={displayCurrency}
          />
        </CardBody>
      </Card>

      <BinanceSyncCard />

      <Card>
        <CardHeader
          title="Transactions"
          description={`${transactions.length} recorded${transactions.length > 25 ? ' — showing 25 most recent' : ''}`}
        />
        <CardBody className="p-0">
          {recentTransactions.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-muted">
              No transactions yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-5 py-2.5 font-medium">Date</th>
                    <th className="px-3 py-2.5 font-medium">Symbol</th>
                    <th className="px-3 py-2.5 font-medium">Side</th>
                    <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-2.5 text-right font-medium">Price</th>
                    <th className="px-3 py-2.5 font-medium">Source</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {recentTransactions.map((tx) => (
                    <tr key={tx.id} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-2.5 text-text-muted nums">{formatDate(tx.timestamp)}</td>
                      <td className="px-3 py-2.5 font-medium text-text">{tx.symbol}</td>
                      <td className={cn('px-3 py-2.5 font-medium', directionClass(tx.type === 'buy' ? 1 : -1))}>
                        {tx.type === 'buy' ? 'Buy' : 'Sell'}
                      </td>
                      <td className="px-3 py-2.5 text-right nums text-text-muted">
                        {formatQuantity(tx.quantity)}
                      </td>
                      <td className="px-3 py-2.5 text-right nums text-text-muted">
                        {formatCurrency(tx.price, tx.currency)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-subtle">
                          {tx.source}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => openEdit(tx)}
                            aria-label={`Edit ${tx.symbol} transaction`}
                            className="rounded-md p-1.5 text-text-muted hover:bg-surface-raised hover:text-text"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            onClick={() => void handleDelete(tx)}
                            aria-label={`Delete ${tx.symbol} transaction`}
                            className="rounded-md p-1.5 text-text-muted hover:bg-surface-raised hover:text-negative"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <TransactionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existing={editing}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
