/**
 * An issuer's payout record.
 *
 * PSX quotes dividends as a percentage of the PKR 10 par value — "250%" means
 * PKR 25 per share, not a 250% yield. That conversion happens server-side, so
 * every amount arriving here is already per-share currency and can be printed
 * as-is. The derived yield is shown next to it because a payout history is
 * only interpretable against the price it is paid on.
 *
 * Shown only where there is something to show: an issuer with no payouts on
 * record renders nothing rather than an empty table, since "no dividends
 * found" and "this company does not pay dividends" are different claims and
 * the data cannot tell them apart.
 */
import { CalendarClock, Coins } from 'lucide-react';
import type { DividendSummary } from '@aminfinance/shared';
import { formatCurrency } from '@/lib/format';

interface DividendPanelProps {
  dividends: DividendSummary;
  currency: string;
  /** Collapsed to the headline figures unless expanded. */
  compact?: boolean;
}

export function DividendPanel({ dividends, currency, compact = false }: DividendPanelProps) {
  const { next, history, trailingAnnualAmount, trailingYieldPercent } = dividends;
  if (!next && history.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/70 bg-surface-sunken px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          <Coins className="size-3.5" />
          Dividends
        </span>

        {trailingAnnualAmount !== null ? (
          <span className="text-[11px] text-text-subtle">
            last 12 months{' '}
            <span className="nums font-medium text-positive">
              {formatCurrency(trailingAnnualAmount, currency)}
            </span>
            {trailingYieldPercent !== null ? (
              <span className="nums text-text-muted"> · {trailingYieldPercent.toFixed(2)}%</span>
            ) : null}
            <span className="text-text-subtle"> per share</span>
          </span>
        ) : null}

        {next ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-text-subtle">
            <CalendarClock className="size-3.5 text-accent" />
            next{' '}
            <span className="nums font-medium text-text">
              {formatCurrency(next.amount, currency)}
            </span>
            <span>on {formatIsoDate(next.exDate)}</span>
          </span>
        ) : null}
      </div>

      {/* The record itself. Without it the trailing total is a number the
          reader has to take on trust; with it, they can see which payouts it
          is made of and whether the issuer pays once or four times a year. */}
      {!compact && history.length > 0 ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-text-subtle hover:text-text-muted">
            <span className="group-open:hidden">
              Show {history.length} past payout{history.length === 1 ? '' : 's'}
            </span>
            <span className="hidden group-open:inline">Hide past payouts</span>
          </summary>
          <table className="mt-1.5 w-full text-[11px]">
            <thead>
              <tr className="text-left text-text-subtle">
                <th className="py-1 pr-3 font-medium">Ex-date</th>
                <th className="py-1 pr-3 text-right font-medium">Per share</th>
                <th className="py-1 font-medium">Declared against</th>
              </tr>
            </thead>
            <tbody>
              {history.map((event) => (
                <tr key={`${event.exDate}:${event.amount}`} className="border-t border-border/50">
                  <td className="nums py-1 pr-3 text-text-muted">{formatIsoDate(event.exDate)}</td>
                  <td className="nums py-1 pr-3 text-right text-text">
                    {formatCurrency(event.amount, currency)}
                  </td>
                  {/* Verbatim from the exchange: "(YR)" and "(HYR)" are what
                      distinguish a final from a half-year payout. */}
                  <td className="py-1 text-text-subtle">{event.period ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

/** "2026-09-18" → "18 Sep 2026". Parsed as UTC so the day never shifts. */
function formatIsoDate(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
