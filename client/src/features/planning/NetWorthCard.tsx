/**
 * Net worth, monthly surplus, and emergency runway in one row.
 *
 * These three belong together because each one qualifies the others: a large
 * net worth with a two-week runway is a liquidity problem, and a healthy
 * surplus with no cash buffer is a plan waiting for one bad month.
 *
 * The surplus tile's copy changes with confidence rather than appending a
 * caveat. Below three months of history there is no median to report, and
 * printing one anyway — from two data points — would dress a guess as a rate.
 */
import { Info } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { useAppSelector } from '@/app/hooks';
import { useWealth, runwayMonths } from './useWealth';
import { useSurplus } from './useSurplus';

export function NetWorthCard({ className }: { className?: string }) {
  const wealth = useWealth();
  const surplus = useSurplus();
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);

  const money = (value: number) =>
    maskIfPrivate(formatCurrency(value, wealth.currency), privacyMode);

  const runway = runwayMonths(wealth.liquidCash, surplus.baselineExpenses);

  /* The surplus tile, per confidence band. */
  const surplusTile = (() => {
    if (surplus.confidence === 'none') {
      return {
        label: 'Monthly surplus',
        value: '—',
        hint: 'No budget months recorded yet',
      };
    }
    if (surplus.reliable === null) {
      // `thin`: one or two months. Show the actual month, labelled as one.
      return {
        label: 'Last month saved',
        value: surplus.latest === null ? '—' : money(surplus.latest),
        hint: `${surplus.sampleMonths} month${surplus.sampleMonths === 1 ? '' : 's'} recorded — too few for a rate`,
      };
    }
    return {
      label: 'Monthly surplus',
      value: money(surplus.reliable),
      hint:
        surplus.variance !== null
          ? `median of ${surplus.sampleMonths} months · ±${money(surplus.variance)}`
          : `median of ${surplus.sampleMonths} months`,
    };
  })();

  return (
    <Card className={className}>
      <CardHeader
        title="Net worth"
        description="Investments plus cash, less what you owe"
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile
            label="Net worth"
            value={money(wealth.netWorth)}
            hint={`${money(wealth.investments)} invested · ${money(wealth.cash)} cash`}
          />
          <StatTile {...surplusTile} />
          <StatTile
            label="Dependable to invest"
            value={surplus.dependable === null ? '—' : money(surplus.dependable)}
            hint={
              surplus.dependable === null
                ? 'Needs 3 months of budget history'
                : 'After allowing for month-to-month variance'
            }
          />
          <StatTile
            label="Emergency runway"
            value={runway === null ? '—' : `${runway.toFixed(1)} mo`}
            hint={
              runway === null
                ? 'Add liquid cash and a budget'
                : `${money(wealth.liquidCash)} liquid`
            }
          />
        </div>

        {wealth.debts > 0 ? (
          <p className="text-xs text-text-subtle">
            Net of {money(wealth.debts)} in recorded debt.
          </p>
        ) : null}

        {/* The balance sheet is only as fresh as its stalest manual row. */}
        {wealth.oldestConfirmedAt !== null ? (
          <p className="flex items-start gap-1.5 border-t border-border pt-3 text-xs text-text-subtle">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Cash and debts are manual. Oldest balance confirmed{' '}
            {Math.floor((Date.now() - wealth.oldestConfirmedAt) / 86_400_000)} days ago.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
