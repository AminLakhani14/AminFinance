/**
 * Binance account sync.
 *
 * Two distinct things, deliberately separated:
 *   - **Balances**: what you hold right now. Always available.
 *   - **Trade history**: how you acquired it, i.e. cost basis. Only exists for
 *     spot fills — assets from Earn, staking, or airdrops have none.
 *
 * That second point is why the WBETH position in this book shows a floating P/L
 * equal to its entire value on Binance: the exchange has no purchase price for
 * it. Importing that as "cost 0" would fabricate a 100% gain, so those assets
 * are imported without a basis and flagged.
 */
import { useState } from 'react';
import { RefreshCw, Link2, TriangleAlert, Check } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useGetBinanceBalancesQuery,
  useLazyGetBinanceTradesQuery,
} from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { importTransactions } from '@/lib/db';
import { formatQuantity, formatCurrency } from '@/lib/format';

export function BinanceSyncCard() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useGetBinanceBalancesQuery();
  const [fetchTrades] = useLazyGetBinanceTradesQuery();
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const apiError = toApiError(error);
  const notConfigured = apiError?.code === 'provider_not_configured';

  async function handleImport() {
    if (!data) return;
    setImporting(true);
    setResult(null);
    try {
      // Only assets with a tradable pair can have spot fills to import.
      const pairs = data.positions
        .map((p) => p.pair)
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 20);

      if (pairs.length === 0) {
        setResult('No tradable pairs found to import.');
        return;
      }

      const trades = await fetchTrades(pairs).unwrap();
      const added = await importTransactions(trades.transactions);

      // Assets held but with no fills — cost basis genuinely unknown.
      const withFills = new Set(trades.transactions.map((t) => t.symbol));
      const missing = pairs.filter((p) => !withFills.has(p));

      const parts = [`Imported ${added} new transaction${added === 1 ? '' : 's'}.`];
      if (added === 0 && trades.transactions.length > 0) {
        parts[0] = 'Already up to date — no new fills.';
      }
      if (missing.length > 0) {
        parts.push(
          `No purchase history for ${missing.join(', ')} — likely acquired via Earn, staking, or a transfer, so cost basis is unknown rather than zero.`,
        );
      }
      setResult(parts.join(' '));
    } catch (err) {
      const parsed = toApiError(err);
      setResult(parsed?.message ?? 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Binance"
        description="Balances and trade history, fetched server-side."
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
            disabled={isFetching || notConfigured}
            aria-label="Refresh balances"
          >
            <RefreshCw className={isFetching ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        }
      />
      <CardBody>
        {notConfigured ? (
          <div className="flex items-start gap-3">
            <Link2 className="mt-0.5 size-4 shrink-0 text-text-subtle" />
            <div className="text-sm">
              <p className="text-text">Not connected.</p>
              <p className="mt-1 text-text-muted">
                Add <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-xs">BINANCE_API_KEY</code>{' '}
                and{' '}
                <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-xs">BINANCE_API_SECRET</code>{' '}
                to <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-xs">server/.env</code>, then
                restart the server.
              </p>
              <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Create the key with <strong>Enable Reading only</strong> — no trading, no
                withdrawals — and set an IP whitelist.
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-text-muted">Loading balances…</p>
        ) : isError ? (
          <p className="text-sm text-negative">{apiError?.message ?? 'Could not reach Binance.'}</p>
        ) : data ? (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-text-muted">Spot value</span>
              <span className="nums text-lg font-semibold text-text">
                {formatCurrency(data.totalUsdt, 'USDT')}
              </span>
            </div>

            <ul className="divide-y divide-border/60">
              {data.positions.map((p) => (
                <li key={p.asset} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium text-text">{p.asset}</span>
                    {p.locked > 0 ? (
                      <span className="ml-2 text-xs text-text-subtle">
                        {formatQuantity(p.locked)} locked
                      </span>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <div className="nums text-text">{formatQuantity(p.total)}</div>
                    <div className="nums text-xs text-text-muted">
                      {p.valueUsdt !== null ? formatCurrency(p.valueUsdt, 'USDT') : '—'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <Button variant="primary" size="sm" onClick={() => void handleImport()} disabled={importing}>
                {importing ? 'Importing…' : 'Import trade history'}
              </Button>
              <span className="text-xs text-text-subtle">
                Safe to re-run — existing fills are skipped.
              </span>
            </div>

            {result ? (
              <p className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-text-muted">
                <Check className="mt-0.5 size-3.5 shrink-0 text-positive" />
                {result}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
