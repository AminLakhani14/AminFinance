/**
 * The zakat assessment, shown as a working rather than a verdict.
 *
 * Design rule here: the total is never the only thing on screen. Zakat is an
 * obligation computed from a chain of judgements — which metal sets the
 * threshold, how equities are treated, which debts were deducted — and a bare
 * "PKR 6,891 due" invites trust the calculation has not earned. So the lines
 * that produced it, the threshold it was measured against, and everything that
 * could not be valued are all on the card.
 *
 * The app does not issue rulings. Where scholars differ, the card names the
 * position it applied and points at the setting that changes it.
 */
import { AlertTriangle, Info, Scale } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { useAppSelector } from '@/app/hooks';
import { cn } from '@/lib/utils';
import { useZakat } from './useZakat';

export function ZakatCard({ className }: { className?: string }) {
  const { assessment, daysToAnniversary, nisabUnavailable, isLoading } = useZakat();
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);

  const money = (value: number, currency: string) =>
    maskIfPrivate(formatCurrency(value, currency), privacyMode);

  if (isLoading || !assessment) {
    return (
      <Card className={className}>
        <CardHeader title="Zakat" description="Calculating from your holdings…" />
        <CardBody>
          <div className="h-24 animate-pulse rounded-lg bg-surface-sunken" />
        </CardBody>
      </Card>
    );
  }

  const { netWealth, nisab, nisabGrams, basis, due, amount, ratePercent, lines, currency } =
    assessment;

  // Distance to the threshold, for the not-due case. Knowing you are 12%
  // below nisab is far more useful than a bare "nothing owed".
  const shortfall = nisab - netWealth;

  return (
    <Card className={className}>
      <CardHeader
        title="Zakat"
        description={`${ratePercent}% of net zakatable wealth · ${basis} nisab (${nisabGrams}g)`}
        action={
          daysToAnniversary !== null ? (
            <span className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-text-muted">
              {daysToAnniversary === 0
                ? 'Due today'
                : `${daysToAnniversary} day${daysToAnniversary === 1 ? '' : 's'} to date`}
            </span>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        {/* The headline. Threshold unknown is its own state — not "nothing
            owed", which would be a claim the data cannot support. */}
        {nisabUnavailable ? (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-sunken p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
            <div className="text-sm">
              <p className="font-medium text-text">Threshold unavailable</p>
              <p className="mt-0.5 text-text-muted">
                Nisab is defined as {nisabGrams}g of {basis}, and the spot price could
                not be fetched — so whether zakat is due cannot be established right
                now. Your zakatable wealth is {money(netWealth, currency)}.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-xs font-medium text-text-muted">
              {due ? 'Zakat payable' : 'Below nisab — nothing payable'}
            </p>
            <p
              className={cn(
                'mt-1 text-3xl font-semibold tracking-tight',
                due ? 'text-text' : 'text-text-muted',
              )}
            >
              {money(amount, currency)}
            </p>
            <p className="mt-1 text-xs text-text-subtle">
              {due
                ? `${ratePercent}% of ${money(netWealth, currency)} zakatable wealth`
                : `${money(shortfall, currency)} below the ${money(nisab, currency)} threshold`}
            </p>
          </div>
        )}

        {/* The working. Every line carries the rule that produced it. */}
        {lines.length > 0 ? (
          <div className="space-y-1.5 border-t border-border pt-3">
            {lines.map((line) => (
              <div key={line.label} className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text">{line.label}</p>
                  {line.note ? (
                    <p className="truncate text-xs text-text-subtle">{line.note}</p>
                  ) : null}
                </div>
                <span
                  className={cn(
                    'shrink-0 text-sm font-medium nums',
                    line.amount < 0 ? 'text-negative' : 'text-text',
                  )}
                >
                  {money(line.amount, currency)}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
              <span className="text-sm font-semibold text-text">Net zakatable wealth</span>
              <span className="text-sm font-semibold text-text nums">
                {money(netWealth, currency)}
              </span>
            </div>
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-sm text-text-muted">
            No zakatable assets recorded yet. Add cash accounts in Planning and your
            holdings will be counted automatically.
          </p>
        )}

        {/* Anything that could not be valued. Never silent: an omitted asset
            understates an obligation. */}
        {assessment.excluded.length > 0 ? (
          <div className="rounded-lg border border-border bg-surface-sunken p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-text">
              <AlertTriangle className="size-3.5 text-negative" aria-hidden />
              Not counted ({assessment.excluded.length})
            </p>
            <ul className="mt-1.5 space-y-1">
              {assessment.excluded.map((item) => (
                <li key={`${item.label}-${item.reason}`} className="text-xs text-text-muted">
                  <span className="font-medium text-text">{item.label}</span> — {item.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The threshold's own provenance, so it can be checked by hand. */}
        {assessment.nisabPricePerGram !== null ? (
          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <Scale className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Nisab {money(nisab, currency)} = {nisabGrams}g × {money(assessment.nisabPricePerGram, currency)}/g {basis} spot.
          </p>
        ) : null}

        <p className="flex items-start gap-1.5 border-t border-border pt-3 text-xs text-text-subtle">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          An estimate to plan with, not a ruling. Scholars differ on the nisab basis
          and on how shares are valued — both are yours to set in Settings. Confirm
          with someone qualified before you pay.
        </p>
      </CardBody>
    </Card>
  );
}
