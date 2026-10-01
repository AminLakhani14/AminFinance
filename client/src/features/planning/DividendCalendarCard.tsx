/**
 * Dividend income: what is coming, and what the book yields.
 *
 * PROJECT_PLAN §2.2 planned this; the provider has been parsing PSX's payouts
 * table all along. What was missing is the portfolio view — a per-share
 * payout is not an income until it is multiplied by a holding.
 *
 * The lead figure is **yield on cost**, not market yield. Market yield answers
 * "what would I get buying today", which is a question about a purchase
 * already made; against cost basis it answers what the user's own money is
 * earning. PSX yields are high enough that the two diverge sharply.
 *
 * `stillCapturable` drives the upcoming list's emphasis: before the ex-date a
 * payout can still be secured by buying, and after it cannot. That deadline is
 * the only genuinely actionable thing on this card.
 */
import { CalendarClock, Coins } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { useAppSelector } from '@/app/hooks';
import { formatCurrency, formatPercent, maskIfPrivate } from '@/lib/format';
import { formatMonthShort } from '@/lib/calc/budget';
import { cn } from '@/lib/utils';
import { useDividendCalendar } from './useDividendCalendar';

export function DividendCalendarCard({ className }: { className?: string }) {
  const {
    upcoming,
    income,
    byMonth,
    projectedAnnualTotal,
    portfolioYieldOnCost,
    isLoading,
    isEmpty,
    currency,
  } = useDividendCalendar();
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);

  const money = (value: number, code = currency) =>
    maskIfPrivate(formatCurrency(value, code), privacyMode);

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader title="Dividend income" description="Reading payout history…" />
        <CardBody>
          <div className="h-24 animate-pulse rounded-lg bg-surface-sunken" />
        </CardBody>
      </Card>
    );
  }

  if (isEmpty) {
    return (
      <Card className={className}>
        <CardHeader title="Dividend income" description="From the exchange's payout record" />
        <CardBody>
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <Coins className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">No payouts recorded</p>
            <p className="mt-1 text-xs text-text-muted">
              None of your holdings has a dividend history the exchange reports.
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  const maxMonth = Math.max(...byMonth.map((m) => m.amount), 1);

  return (
    <Card className={className}>
      <CardHeader
        title="Dividend income"
        description="Projected from the trailing twelve months of payouts"
      />
      <CardBody className="space-y-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatTile
            label="Projected annual"
            value={money(projectedAnnualTotal)}
            hint="At your current holdings"
          />
          <StatTile
            label="Yield on cost"
            value={
              portfolioYieldOnCost === null ? '—' : formatPercent(portfolioYieldOnCost)
            }
            hint="What your own money earns"
          />
          <StatTile
            label="Monthly average"
            value={money(projectedAnnualTotal / 12)}
            hint="Payouts are lumpy, not monthly"
          />
        </div>

        {/* Upcoming — the only part with a deadline. */}
        {upcoming.length > 0 ? (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-text">
              <CalendarClock className="size-3.5" aria-hidden />
              Announced
            </p>
            {upcoming.map((row) => (
              <div
                key={`${row.symbol}-${row.exDate}`}
                className={cn(
                  'flex items-baseline justify-between gap-3 rounded-lg border p-2.5',
                  row.stillCapturable ? 'border-positive/40 bg-positive/5' : 'border-border',
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{row.symbol}</p>
                  <p className="text-xs text-text-muted">
                    Ex-date {row.exDate}
                    {row.stillCapturable
                      ? ` · ${row.daysToExDate === 0 ? 'today' : `in ${row.daysToExDate}d`}`
                      : ' · passed'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-text nums">
                    {money(row.total, row.currency)}
                  </p>
                  <p className="text-xs text-text-subtle nums">
                    {money(row.amountPerShare, row.currency)}/share
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Twelve-month history. Bars, because the question is "which months
            paid" — a line would imply a continuous series that payouts are not. */}
        {byMonth.length > 0 ? (
          <div className="border-t border-border pt-4">
            <p className="text-xs font-medium text-text">Last twelve months</p>
            <div className="mt-2 flex items-end gap-1" style={{ height: 64 }}>
              {byMonth.map((month) => (
                <div
                  key={month.month}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                  title={`${formatMonthShort(month.month)} — ${money(month.amount)}`}
                >
                  <div
                    className="w-full rounded-t bg-accent/70"
                    style={{ height: `${Math.max(2, (month.amount / maxMonth) * 48)}px` }}
                  />
                  <span className="truncate text-[10px] text-text-subtle">
                    {formatMonthShort(month.month).slice(0, 1)}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-text-subtle">
              Actual past payouts, valued at your current quantities.
            </p>
          </div>
        ) : null}

        {/* Per-holding yields. */}
        {income.length > 0 ? (
          <div className="space-y-1 border-t border-border pt-4">
            {income.map((row) => (
              <div key={row.symbol} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-text">{row.symbol}</span>
                <div className="flex shrink-0 items-baseline gap-3">
                  <span className="text-xs text-text-subtle nums">
                    {row.yieldOnCostPercent === null
                      ? '—'
                      : `${formatPercent(row.yieldOnCostPercent)} on cost`}
                  </span>
                  <span className="text-sm font-medium text-text nums">
                    {money(row.projectedAnnual ?? 0, row.currency)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <p className="border-t border-border pt-3 text-xs text-text-subtle">
          Projected from the trailing twelve months, which assumes the issuer keeps
          paying at the same rate — it may not. PSX quotes payouts as a percent of
          par value; the amounts here are already converted to currency per share.
        </p>
      </CardBody>
    </Card>
  );
}
