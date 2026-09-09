/**
 * Holdings table — the portfolio's primary view, and the table view that
 * satisfies the charts' relief rule.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { HoldingWithFlags } from '@/lib/calc/costBasis';
import { Sparkline } from '@/components/charts/Sparkline';
import { LivePrice } from '@/components/ui/LivePrice';
import { InstrumentLogo } from '@/components/ui/InstrumentLogo';
import { formatCurrency, formatPercent, formatQuantity, directionClass } from '@/lib/format';
import { useAppSelector } from '@/app/hooks';
import { cn } from '@/lib/utils';

interface HoldingsTableProps {
  holdings: HoldingWithFlags[];
  /** Recent closes per symbol, for the trend column. */
  sparklines?: Map<string, number[]>;
  convert: (amount: number, currency: string) => number;
  displayCurrency: string;
}

export function HoldingsTable({
  holdings,
  sparklines,
  convert,
  displayCurrency,
}: HoldingsTableProps) {
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);

  if (holdings.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-text-muted">
        No open positions. Add a transaction or sync from Binance to get started.
      </p>
    );
  }

  const hide = (text: string) => (privacyMode ? '••••••' : text);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="px-5 py-2.5 font-medium">Symbol</th>
            <th className="px-3 py-2.5 text-right font-medium">Qty</th>
            <th className="px-3 py-2.5 text-right font-medium">Avg cost</th>
            <th className="px-3 py-2.5 text-right font-medium">Price</th>
            <th className="px-3 py-2.5 text-right font-medium">Value</th>
            <th className="px-3 py-2.5 text-right font-medium">P/L</th>
            <th className="px-3 py-2.5 text-right font-medium">Alloc</th>
            <th className="px-3 py-2.5 text-right font-medium">Trend</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const values = sparklines?.get(h.symbol) ?? [];
            const direction =
              h.unrealizedPnl > 0 ? 'up' : h.unrealizedPnl < 0 ? 'down' : 'flat';

            return (
              <tr
                key={h.symbol}
                className="border-b border-border/60 transition-colors last:border-0 hover:bg-surface-raised"
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <InstrumentLogo
                      symbol={h.symbol}
                      assetClass={h.assetClass}
                      currency={h.currency}
                    />
                    <div>
                      <Link
                        to={`/asset/${encodeURIComponent(h.symbol)}`}
                        className="font-medium text-text hover:text-accent"
                      >
                        {h.symbol}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-[11px] uppercase tracking-wide text-text-subtle">
                          {h.assetClass}
                        </span>
                        {h.hasUnknownCost ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] text-warning"
                            title="Part of this position has no recorded purchase price — P/L is incomplete, not zero."
                          >
                            <AlertTriangle className="size-3" />
                            cost unknown
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>

                <td className="px-3 py-3 text-right nums text-text-muted">
                  {formatQuantity(h.quantity)}
                </td>
                <td className="px-3 py-3 text-right nums text-text-muted">
                  {h.costBasisKnown ? (
                    hide(formatCurrency(h.averageCost, h.currency))
                  ) : (
                    <span title="No purchase price recorded for this position.">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right text-text">
                  <LivePrice
                    symbol={h.symbol}
                    fallbackPrice={h.currentPrice}
                    currency={h.currency}
                  />
                </td>
                <td className="px-3 py-3 text-right nums font-medium text-text">
                  {hide(formatCurrency(convert(h.marketValue, h.currency), displayCurrency))}
                </td>

                {h.costBasisKnown ? (
                  <td
                    className={cn(
                      'px-3 py-3 text-right nums font-medium',
                      directionClass(h.unrealizedPnl),
                    )}
                  >
                    <div>
                      {hide(formatCurrency(convert(h.unrealizedPnl, h.currency), displayCurrency))}
                    </div>
                    <div className="text-xs font-normal">
                      {formatPercent(h.unrealizedPnlPercent)}
                    </div>
                  </td>
                ) : (
                  // No cost basis means no knowable P/L. Showing marketValue − 0
                  // would report the entire position as profit.
                  <td className="px-3 py-3 text-right">
                    <span
                      className="nums text-text-subtle"
                      title="Cost basis unknown — P/L cannot be calculated. Edit the transaction to add what you paid."
                    >
                      —
                    </span>
                  </td>
                )}

                <td className="px-3 py-3 text-right nums text-text-muted">
                  {h.allocationPercent.toFixed(1)}%
                </td>

                <td className="px-3 py-3">
                  <div className="flex justify-end">
                    <Sparkline values={values} direction={direction} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
