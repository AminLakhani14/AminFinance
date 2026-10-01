/**
 * Nominal return against inflation, and against the risk-free alternative.
 *
 * The case for this card: with Pakistani CPI in double digits, a portfolio up
 * 8% has *lost* purchasing power, and every other screen in this app reports
 * that 8% in green. This is the one view that says what the money actually
 * did.
 *
 * The second comparison matters as much. For most savers here the real
 * counterfactual is not cash — it is a National Savings certificate at a
 * double-digit rate, and a portfolio that trails it was risk taken for
 * nothing. A tracker that only benchmarks against its own cost basis never
 * asks that question.
 *
 * Both rates are user-entered, and the card degrades to an invitation rather
 * than inventing a CPI figure.
 */
import { AlertTriangle, ArrowRight, TrendingDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { useAppSelector } from '@/app/hooks';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { compareToSavings, daysSinceRateUpdate, ratesAreStale } from '@/lib/calc/inflation';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

export function RealReturnCard({ className }: { className?: string }) {
  const rates = useAppSelector((s) => s.settings.rates);
  const { summary } = usePortfolio();

  const nominal = summary.totalUnrealizedPnlPercent;
  const comparison = compareToSavings(nominal, rates);
  const stale = ratesAreStale(rates);
  const age = daysSinceRateUpdate(rates);

  // No CPI entered means no real-return story to tell. An invitation is the
  // honest state — a shipped default would be indistinguishable from a figure
  // the user had confirmed, and would restate every return against a number
  // nobody chose.
  if (rates.inflationPercent === 0 && rates.savingsRatePercent === 0) {
    return (
      <Card className={className}>
        <CardHeader title="Real return" description="What your money actually bought" />
        <CardBody>
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <TrendingDown className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">No inflation rate set</p>
            <p className="mt-1 text-xs text-text-muted">
              Your portfolio is {formatPercent(nominal)} nominally. With inflation in
              double digits, that may be a real loss — enter the current CPI to see
              which.
            </p>
            <Link
              to="/settings"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              Set rates in Settings
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader
        title="Real return"
        description={`Against ${formatPercent(rates.inflationPercent)} inflation`}
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatTile label="Nominal" value={formatPercent(nominal)} />
          <StatTile
            label="Real (after inflation)"
            value={formatPercent(comparison.portfolioRealPercent)}
            hint={
              comparison.portfolioRealPercent < 0
                ? 'Purchasing power fell'
                : 'Purchasing power grew'
            }
          />
          <StatTile
            label={comparison.savingsLabel}
            value={formatPercent(comparison.savingsPercent)}
            hint={`${formatPercent(comparison.savingsRealPercent)} real`}
          />
        </div>

        {/* The verdict, stated once and plainly. */}
        <div
          className={cn(
            'rounded-lg border p-3 text-sm',
            comparison.savingsWon
              ? 'border-negative/40 bg-negative/5'
              : 'border-border bg-surface-sunken',
          )}
        >
          {comparison.savingsWon ? (
            <p className="text-text">
              <span className="font-medium">
                {comparison.savingsLabel} would have paid more.
              </span>{' '}
              It returns {formatPercent(comparison.savingsPercent)} against your{' '}
              {formatPercent(nominal)} — {formatPercent(Math.abs(comparison.excessPercent))}{' '}
              of risk taken for nothing.
            </p>
          ) : (
            <p className="text-text">
              <span className="font-medium">
                Ahead of {comparison.savingsLabel} by{' '}
                {formatPercent(comparison.excessPercent)}.
              </span>{' '}
              That margin is what the extra risk bought.
            </p>
          )}
          {comparison.bothLostToInflation ? (
            <p className="mt-1.5 text-xs text-text-muted">
              Both lost to inflation this period — the safe option was not safe
              either.
            </p>
          ) : null}
        </div>

        {stale ? (
          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-negative" aria-hidden />
            {age === null
              ? 'These rates have never been confirmed.'
              : `Rates last updated ${age} days ago — CPI is published monthly.`}{' '}
            <Link to="/settings" className="font-medium text-accent hover:underline">
              Update
            </Link>
          </p>
        ) : null}

        <p className="border-t border-border pt-3 text-xs text-text-subtle">
          Real return uses the Fisher relation, not nominal minus inflation — at
          these rates the shortcut is materially wrong. Return shown is unrealized
          P/L on open positions, not time-weighted.
        </p>
      </CardBody>
    </Card>
  );
}
