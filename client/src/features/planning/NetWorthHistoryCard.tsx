/**
 * Recorded net worth over time — the real series, not a reconstruction.
 *
 * The distinction matters and the card states it. Everywhere else the app
 * shows a value history, that history is *reconstructed*: `reconstructHistory`
 * takes today's quantities and replays them over past prices, which answers
 * "how would my current book have moved" rather than "what was I worth". A
 * position opened last week appears in it as though held all year.
 *
 * This chart reads the `snapshots` table, which `useNetWorthRecorder` began
 * filling one row per day. It is therefore short at first and cannot be
 * backfilled — that is the honest cost of the distinction, and the empty state
 * says so rather than quietly falling back to the reconstruction.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { History } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { db } from '@/lib/db';
import { useAppSelector } from '@/app/hooks';
import { formatCurrency, formatDate, formatPercent, maskIfPrivate } from '@/lib/format';
import { AreaChart, type AreaPoint } from '@/components/charts/AreaChart';

/** Below this, a chart of the series would be two dots and a line. */
const MIN_POINTS = 3;

export function NetWorthHistoryCard({ className }: { className?: string }) {
  const snapshots = useLiveQuery(() => db.snapshots.orderBy('timestamp').toArray(), []);
  const currency = useAppSelector((s) => s.settings.displayCurrency);
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);

  const points = useMemo<AreaPoint[]>(
    () =>
      (snapshots ?? []).map((snapshot) => ({
        timestamp: snapshot.timestamp,
        value: snapshot.totalValue,
      })),
    [snapshots],
  );

  const money = (value: number) => maskIfPrivate(formatCurrency(value, currency), privacyMode);

  const change = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last || first.value === 0) return null;
    return {
      absolute: last.value - first.value,
      percent: ((last.value - first.value) / first.value) * 100,
      from: first.timestamp,
    };
  }, [points]);

  return (
    <Card className={className}>
      <CardHeader
        title="Recorded net worth"
        description="Actual daily valuations — not reconstructed from today's holdings"
      />
      <CardBody>
        {snapshots === undefined ? (
          <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" />
        ) : points.length < MIN_POINTS ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <History className="mx-auto size-5 text-text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-text">
              {points.length === 0
                ? 'No history recorded yet'
                : `${points.length} day${points.length === 1 ? '' : 's'} recorded`}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              One snapshot is saved each day you open the app. This series cannot be
              backfilled — unlike the reconstructed chart elsewhere, it only knows
              what was actually true on the days it was recorded.
            </p>
          </div>
        ) : (
          <>
            <AreaChart data={points} currency={currency} />
            {change !== null ? (
              <p className="mt-3 text-xs text-text-muted">
                {money(change.absolute)} ({formatPercent(change.percent)}) since{' '}
                {formatDate(change.from)} · {points.length} days recorded
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
