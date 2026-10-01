/**
 * Pakistan macro indicators — the backdrop a PKR portfolio sits against.
 *
 * Per the form heuristic, each of these figures' job is "one number", so the
 * form is a stat tile rather than a chart. The sparkline beside it is there for
 * the one thing a tile cannot carry — whether reserves are recovering or still
 * falling — and deliberately has no axes, ticks, or labels: at this size they
 * would be decoration, and the tile already states the current value.
 *
 * Groups are ordered by how directly they bear on a portfolio: external
 * position first (reserves are what the rupee defends), then trade, prices, and
 * activity last.
 */
import type { EconomyIndicator, IndicatorGroup } from '@aminfinance/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { useGetEconomyQuery } from '@/services/endpoints';
import { toApiError } from '@/services/api';
import { compactNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

const GROUPS: Array<{ key: IndicatorGroup; label: string; description: string }> = [
  {
    key: 'external',
    label: 'External position',
    description: 'What backs the rupee, and what is owed against it.',
  },
  { key: 'trade', label: 'Trade', description: 'Monthly goods trade, in rupees.' },
  { key: 'prices', label: 'Prices & currency', description: 'What your PKR is worth.' },
  { key: 'activity', label: 'Activity', description: 'Output and employment.' },
];

export function EconomyPanel() {
  const { data, isFetching, error } = useGetEconomyQuery();
  const apiError = toApiError(error);

  if (error && !data) {
    return (
      <Card>
        <CardHeader title="Pakistan economy" />
        <CardBody>
          <p className="text-sm text-negative">
            {apiError?.message ?? 'Could not load economic data.'}
          </p>
        </CardBody>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader title="Pakistan economy" description="Loading indicators…" />
        <CardBody>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-24 animate-pulse rounded bg-surface-raised" />
                <div className="h-6 w-32 animate-pulse rounded bg-surface-raised" />
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    );
  }

  const failures = Object.keys(data.errors ?? {}).length;

  return (
    <div className="space-y-6">
      {GROUPS.map((group) => {
        const indicators = data.indicators.filter((i) => i.group === group.key);
        // A group whose every series failed renders as nothing rather than as
        // an empty card — the failure note at the bottom already accounts for it.
        if (indicators.length === 0) return null;

        return (
          <Card key={group.key}>
            <CardHeader
              title={group.label}
              description={group.description}
              {...(isFetching ? { action: <span className="text-xs text-text-subtle">Refreshing…</span> } : {})}
            />
            <CardBody>
              <div className="grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
                {indicators.map((indicator) => (
                  <IndicatorTile key={indicator.id} indicator={indicator} />
                ))}
              </div>
            </CardBody>
          </Card>
        );
      })}

      <p className="text-xs text-text-subtle">
        Monthly CPI and goods trade from the IMF; annual series from the World Bank; USD/PKR
        live from open.er-api.com. Pakistan&rsquo;s fiscal year runs July&ndash;June, but every
        series here is calendar-period and each tile states the month or year it covers.
        Reserves stay annual because Pakistan does not report monthly to the IMF and
        SBP&rsquo;s weekly figure needs an API key.
        {failures > 0 ? ` ${failures} series unavailable right now.` : ''}
      </p>
    </div>
  );
}

function IndicatorTile({ indicator }: { indicator: EconomyIndicator }) {
  const { value, unit, changePercent, changeBasis, periodLabel, history, note, label, period } =
    indicator;

  return (
    <div className="min-w-0">
      <StatTile
        label={label}
        value={value === null ? '—' : formatIndicator(value, unit)}
        delta={changePercent}
        {...(changePercent !== null
          ? {
              deltaLabel: `${formatPercent(changePercent)}${
                changeBasis ? ` ${changeBasis}` : ''
              }`,
            }
          : {})}
        {...(changePercent === null ? { hint: periodLabel } : {})}
      />
      {/* The period repeats under the sparkline only when the delta line has
          taken the hint slot — otherwise it would appear twice. */}
      {changePercent !== null ? (
        <p className="mt-0.5 text-xs text-text-subtle">{periodLabel}</p>
      ) : null}
      {/* The cadence, beside the period. Two tiles can both read "current" and
          mean different things — Aug 2026 monthly against a 2025 annual — and
          without this the annual one silently looks as fresh as its neighbour. */}
      <PeriodBadge period={period} />
      {history.length >= 3 ? (
        <Sparkline points={history} className="mt-2" />
      ) : null}
      {note ? <p className="mt-1.5 text-[11px] leading-snug text-text-subtle">{note}</p> : null}
    </div>
  );
}

/**
 * How often the series updates.
 *
 * Deliberately muted: this is a caveat on the number above, not a headline, and
 * the annual case is the one worth noticing — it is the tile most likely to be
 * misread as current.
 */
function PeriodBadge({ period }: { period: EconomyIndicator['period'] }) {
  const text = period === 'daily' ? 'Live' : period === 'monthly' ? 'Monthly' : 'Annual';
  return (
    <span
      className={cn(
        'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        period === 'annual'
          ? 'bg-warning/10 text-warning'
          : 'bg-surface-raised text-text-subtle',
      )}
      title={
        period === 'annual'
          ? 'Reported once a year — the most recent published figure.'
          : period === 'monthly'
            ? 'Reported monthly.'
            : 'Updated daily.'
      }
    >
      {text}
    </span>
  );
}

/**
 * Units decide precision, not the magnitude alone.
 *
 * Reserves in full digits ("18,407,745,860") is unreadable and implies
 * dollar-level precision the series does not have, so USD figures go compact.
 * A rate needs its decimals.
 */
function formatIndicator(value: number, unit: EconomyIndicator['unit']): string {
  switch (unit) {
    case 'USD':
      return `$${compactNumber(value)}`;
    case 'PKR':
      return `₨${compactNumber(value)}`;
    case 'PKR/USD':
      return value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    case '%':
      return `${value.toFixed(1)}%`;
  }
}

/**
 * A bare trend line: no axes, no grid, no point labels.
 *
 * Colour is not the signal — the line's shape is — so it inherits the text
 * colour via `currentColor` and stays legible in both themes without a
 * theme-specific stroke. The whole series is summarised in `aria-label` rather
 * than the SVG being hidden, so the trend is available to a screen reader
 * instead of being purely visual.
 */
function Sparkline({
  points,
  className,
}: {
  points: EconomyIndicator['history'];
  className?: string;
}) {
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const width = 100;
  const height = 24;
  // Inset by the stroke's half-width so the first and last points are not
  // clipped by the viewBox edge.
  const pad = 1.5;

  const path = points
    .map((point, i) => {
      const x = pad + (i / (points.length - 1)) * (width - pad * 2);
      // A flat series has no span to scale against; centre it rather than
      // dividing by zero.
      const y =
        span === 0
          ? height / 2
          : height - pad - ((point.value - min) / span) * (height - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const first = points[0];
  const last = points[points.length - 1];
  const rising = last && first ? last.value >= first.value : false;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      // Stretches to the tile width; the trend's shape is what matters, not a
      // fixed aspect ratio.
      preserveAspectRatio="none"
      className={cn('h-6 w-full text-text-subtle', className)}
      role="img"
      aria-label={
        first && last
          ? `Trend ${first.periodLabel} to ${last.periodLabel}: ${rising ? 'up' : 'down'} overall.`
          : 'Trend unavailable.'
      }
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        // 2px at the rendered height, per the mark spec. Non-scaling so the
        // horizontal stretch above does not thin the line.
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
