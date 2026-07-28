/**
 * Allocation by holding.
 *
 * Categorical colour (identity), assigned in fixed slot order and keyed on the
 * symbol so re-sorting never repaints a segment. Segments carry a 2px surface
 * gap so adjacent fills stay separable — which is also what makes the palette's
 * adjacent-pair CVD validation the right gate.
 *
 * Three light-mode slots sit below 3:1 contrast on white, so the relief rule
 * applies: this chart always ships a labelled legend with values, and the
 * holdings table beside it is the table view.
 */
import { useMemo, useState } from 'react';
import { buildColorMap, foldToOther } from './palette';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface DonutSlice {
  symbol: string;
  value: number;
}

interface DonutChartProps {
  data: DonutSlice[];
  currency: string;
  size?: number;
  className?: string;
}

/** Gap between segments, in degrees — the 2px surface spacer at this radius. */
const GAP_DEGREES = 1.5;

export function DonutChart({ data, currency, size = 200, className }: DonutChartProps) {
  const [active, setActive] = useState<string | null>(null);

  const { slices, total, colors } = useMemo(() => {
    const folded = foldToOther(data);
    const sum = folded.reduce((s, d) => s + d.value, 0);
    const colorMap = buildColorMap(folded.map((d) => d.symbol));

    let cursor = -90; // start at 12 o'clock
    const arcs = folded.map((slice) => {
      const fraction = sum > 0 ? slice.value / sum : 0;
      const sweep = fraction * 360;
      const start = cursor + GAP_DEGREES / 2;
      const end = cursor + sweep - GAP_DEGREES / 2;
      cursor += sweep;
      return { ...slice, start, end: Math.max(start, end), fraction };
    });

    return { slices: arcs, total: sum, colors: colorMap };
  }, [data]);

  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-sm text-text-muted" style={{ height: size }}>
        Nothing to allocate yet.
      </div>
    );
  }

  const radius = size / 2;
  const thickness = size * 0.17;
  const inner = radius - thickness;

  return (
    <div className={cn('flex flex-wrap items-center gap-6', className)}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Allocation across ${slices.length} holdings`}
      >
        {slices.map((slice) => (
          <path
            key={slice.symbol}
            d={arcPath(radius, radius, inner, radius - 2, slice.start, slice.end)}
            fill={colors.get(slice.symbol) ?? 'var(--viz-1)'}
            opacity={active === null || active === slice.symbol ? 1 : 0.35}
            onMouseEnter={() => setActive(slice.symbol)}
            onMouseLeave={() => setActive(null)}
            style={{ transition: 'opacity 150ms' }}
          />
        ))}

        {/* Centre reads the hovered slice, or the total at rest. */}
        <text
          x={radius}
          y={radius - 6}
          textAnchor="middle"
          fontSize="11"
          fill="var(--text-muted)"
        >
          {active ?? 'Total'}
        </text>
        <text
          x={radius}
          y={radius + 12}
          textAnchor="middle"
          fontSize="14"
          fontWeight="600"
          fill="var(--text)"
        >
          {active
            ? `${((slices.find((s) => s.symbol === active)?.fraction ?? 0) * 100).toFixed(1)}%`
            : formatCurrency(total, currency, { compact: true })}
        </text>
      </svg>

      {/* Legend is always present for ≥2 series, and carries the value — so
          identity is never colour-alone. */}
      <ul className="min-w-0 flex-1 space-y-1.5">
        {slices.map((slice) => (
          <li
            key={slice.symbol}
            className="flex items-center gap-2 text-sm"
            onMouseEnter={() => setActive(slice.symbol)}
            onMouseLeave={() => setActive(null)}
          >
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: colors.get(slice.symbol) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-text">{slice.symbol}</span>
            {/* A share, not a change — signing it would imply direction. */}
            <span className="nums text-text-muted">{(slice.fraction * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Donut segment path. Angles in degrees, 0 = 3 o'clock. */
function arcPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startDeg: number,
  endDeg: number,
): string {
  const toXY = (r: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };

  // A full circle can't be drawn with one arc — nudge it just short of 360.
  const sweep = Math.min(endDeg - startDeg, 359.99);
  const end = startDeg + sweep;
  const largeArc = sweep > 180 ? 1 : 0;

  const [x1, y1] = toXY(outerR, startDeg);
  const [x2, y2] = toXY(outerR, end);
  const [x3, y3] = toXY(innerR, end);
  const [x4, y4] = toXY(innerR, startDeg);

  return [
    `M${x1},${y1}`,
    `A${outerR},${outerR} 0 ${largeArc} 1 ${x2},${y2}`,
    `L${x3},${y3}`,
    `A${innerR},${innerR} 0 ${largeArc} 0 ${x4},${y4}`,
    'Z',
  ].join(' ');
}
