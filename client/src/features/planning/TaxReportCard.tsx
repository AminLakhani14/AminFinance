/**
 * Capital-gains estimate for a Pakistani tax year.
 *
 * The July-June window is the reason this cannot be read off the Portfolio
 * page's realized-P/L total: a disposal on 15 June and one on 15 July fall in
 * different tax years, so a running total is wrong for everything closed in
 * the second half of the calendar year.
 *
 * Rates are user-maintained and the card says so plainly. Pakistan's rates
 * change with each Finance Act, and the failure mode of a hardcoded rate is
 * not an error — it is a confident wrong answer every year after the first.
 */
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileText, Info } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { db } from '@/lib/db';
import { useAppSelector } from '@/app/hooks';
import { usePortfolio } from '@/features/portfolio/usePortfolio';
import { buildPositions } from '@/lib/calc/costBasis';
import {
  availableTaxYears,
  buildTaxYearReport,
  currencyBySymbolFrom,
} from '@/lib/calc/tax';
import { formatCurrency, formatDate, maskIfPrivate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function TaxReportCard({ className }: { className?: string }) {
  const taxSettings = useAppSelector((s) => s.settings.tax);
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  const { convert, displayCurrency } = usePortfolio();

  const transactions = useLiveQuery(() => db.transactions.toArray(), []);

  // Realized gains come from the same cost-basis engine the Portfolio page
  // uses, so the two can never disagree about what was sold for what.
  const gains = useMemo(() => {
    const positions = buildPositions(transactions ?? []);
    return [...positions.values()].flatMap((position) => position.realized);
  }, [transactions]);

  const years = useMemo(
    () => availableTaxYears(gains, taxSettings.taxYearStartMonth),
    [gains, taxSettings.taxYearStartMonth],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const activeYear = selected ?? years[0]?.label ?? null;
  const activeBounds = years.find((y) => y.label === activeYear) ?? years[0];

  const report = useMemo(() => {
    if (!activeBounds) return null;
    return buildTaxYearReport({
      gains,
      settings: taxSettings,
      currencyBySymbol: currencyBySymbolFrom(transactions ?? []),
      convert,
      currency: displayCurrency,
      // Midpoint of the window, so `taxYearBounds` resolves to this year
      // regardless of where "now" sits.
      at: activeBounds.from + (activeBounds.to - activeBounds.from) / 2,
    });
  }, [gains, taxSettings, transactions, convert, displayCurrency, activeBounds]);

  const money = (value: number) =>
    maskIfPrivate(formatCurrency(value, displayCurrency), privacyMode);

  return (
    <Card className={className}>
      <CardHeader
        title="Capital gains tax"
        description={`Tax year ${activeYear ?? '—'} · ${taxSettings.filerStatus} · ${report?.appliedRatePercent ?? 0}%`}
        action={
          years.length > 1 ? (
            <select
              value={activeYear ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              className="shrink-0 rounded-lg border border-border bg-surface-sunken px-2 py-1 text-xs text-text outline-none focus:border-accent"
              aria-label="Tax year"
            >
              {years.map((year) => (
                <option key={year.label} value={year.label}>
                  {year.label}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        {!report || report.disposals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <FileText className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">No disposals recorded</p>
            <p className="mt-1 text-xs text-text-muted">
              Capital gains tax applies when you sell. Nothing has been closed in
              this tax year.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Gains" value={money(report.totalGains)} tone="positive" />
              <Figure label="Losses" value={money(report.totalLosses)} tone="negative" />
              <Figure
                label="Net"
                value={money(report.netGain)}
                tone={report.netGain >= 0 ? 'positive' : 'negative'}
              />
              <Figure label="Estimated tax" value={money(report.estimatedTax)} />
            </div>

            <p className="text-xs text-text-subtle">
              {formatDate(report.from)} – {formatDate(report.to)} ·{' '}
              {report.disposals.length} disposal
              {report.disposals.length === 1 ? '' : 's'}
            </p>

            <div className="space-y-1 border-t border-border pt-3">
              {report.disposals.slice(0, 8).map((disposal) => (
                <div
                  key={`${disposal.symbol}-${disposal.soldAt}`}
                  className="flex items-baseline justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">{disposal.symbol}</p>
                    <p className="text-xs text-text-subtle">
                      {formatDate(disposal.soldAt)}
                      {disposal.holdingDays !== null
                        ? ` · held ${disposal.holdingDays}d`
                        : ''}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-sm font-medium nums',
                      disposal.gain >= 0 ? 'text-positive' : 'text-negative',
                    )}
                  >
                    {money(disposal.gain)}
                  </span>
                </div>
              ))}
              {report.disposals.length > 8 ? (
                <p className="pt-1 text-xs text-text-subtle">
                  + {report.disposals.length - 8} more
                </p>
              ) : null}
            </div>
          </>
        )}

        <p className="flex items-start gap-1.5 border-t border-border pt-3 text-xs text-text-subtle">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          An estimate, not a return. CGT on listed securities is withheld at source
          by NCCPL, and the rates here are the ones you entered in Settings — check
          them against the current Finance Act. Loss carry-forward is not modelled.
        </p>
      </CardBody>
    </Card>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-text-muted">{label}</p>
      <p
        className={cn(
          'mt-1 truncate text-lg font-semibold tracking-tight nums',
          tone === 'positive'
            ? 'text-positive'
            : tone === 'negative'
              ? 'text-negative'
              : 'text-text',
        )}
      >
        {value}
      </p>
    </div>
  );
}
