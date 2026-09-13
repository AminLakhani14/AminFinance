/**
 * Income against spending, month by month.
 *
 * Paired bars on a shared baseline: the comparison that matters is "was the
 * green bar taller than the red one", and adjacent bars answer it without the
 * reader doing arithmetic. A stacked form would hide exactly that.
 *
 * Two series only, and they are semantic (in vs out) rather than categorical,
 * so they use the positive/negative tokens instead of palette slots — the same
 * colours the rest of the app already uses for money in and money out.
 */
import { useMemo, useState } from 'react';
import type { MonthlyPoint } from '@/lib/calc/budget';
import { formatMonthShort, formatMonth } from '@/lib/calc/budget';
import { compactNumber, formatCurrency, maskIfPrivate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface SavingsTrendProps {
  data: MonthlyPoint[];
  currency: string;
  privacyMode: boolean;
  /** Highlighted month — the one the page is showing. */
  activeMonth: string;
  onSelectMonth?: (month: string) => void;
  height?: number;
  className?: string;
}

const PAD = { top: 16, right: 8, bottom: 28, left: 52 };

export function SavingsTrend({
  data,
  currency,
  privacyMode,
  activeMonth,
  onSelectMonth,
  height = 220,
  className,
}: SavingsTrendProps) {
  const [hover, setHover] = useState<string | null>(null);

  // A viewBox with preserveAspectRatio="none" would distort the text, so the
  // chart is laid out in a fixed coordinate space and scaled by CSS width
  // instead — the bars stay proportional and the labels stay upright.
  const width = 720;

  const geometry = useMemo(() => {
    const max = Math.max(...data.map((d) => Math.max(d.income, d.expenses)), 1);
    // Round the ceiling up to a clean number so the gridline labels read as
    // round figures rather than "47,318".
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const ceiling = Math.ceil(max / magnitude) * magnitude;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const slot = plotW / Math.max(data.length, 1);
    // Two bars per slot with a gutter between groups.
    const barW = Math.max(3, (slot * 0.62) / 2);

    const y = (value: number) => PAD.top + plotH - (value / ceiling) * plotH;

    const bars = data.map((point, i) => {
      const centre = PAD.left + slot * i + slot / 2;
      return {
        ...point,
        incomeX: centre - barW - 1,
        expenseX: centre + 1,
        incomeY: y(point.income),
        expenseY: y(point.expenses),
        incomeH: Math.max(0, PAD.top + plotH - y(point.income)),
        expenseH: Math.max(0, PAD.top + plotH - y(point.expenses)),
        centre,
        slotX: PAD.left + slot * i,
        slotW: slot,
      };
    });

    const ticks = [0, 0.5, 1].map((f) => ({ value: ceiling * f, y: y(ceiling * f) }));

    return { bars, ticks, barW, baseline: PAD.top + plotH };
  }, [data, height]);

  if (data.length === 0) return null;

  const active = hover ?? activeMonth;
  const activePoint = data.find((d) => d.month === active);

  return (
    <div className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Income and spending for the last ${data.length} months`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Gridlines sit behind the bars and carry the value scale. */}
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={tick.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-subtle)"
            >
              {privacyMode ? '•••' : compactNumber(tick.value)}
            </text>
          </g>
        ))}

        {geometry.bars.map((bar) => {
          const isActive = bar.month === active;
          return (
            <g
              key={bar.month}
              onMouseEnter={() => setHover(bar.month)}
              onClick={() => onSelectMonth?.(bar.month)}
              style={{ cursor: onSelectMonth ? 'pointer' : 'default' }}
            >
              {/* Full-height hit area — catching only the bars would make the
                  empty months unhoverable and the short ones fiddly. */}
              <rect
                x={bar.slotX}
                y={PAD.top}
                width={bar.slotW}
                height={geometry.baseline - PAD.top}
                fill={isActive ? 'var(--accent)' : 'transparent'}
                opacity={isActive ? 0.07 : 0}
              />
              <rect
                x={bar.incomeX}
                y={bar.incomeY}
                width={geometry.barW}
                height={bar.incomeH}
                rx={2}
                fill="var(--positive)"
                opacity={isActive ? 1 : 0.75}
              />
              <rect
                x={bar.expenseX}
                y={bar.expenseY}
                width={geometry.barW}
                height={bar.expenseH}
                rx={2}
                fill="var(--negative)"
                opacity={isActive ? 1 : 0.75}
              />
              <text
                x={bar.centre}
                y={height - 9}
                textAnchor="middle"
                fontSize="10"
                fontWeight={isActive ? 600 : 400}
                fill={isActive ? 'var(--text)' : 'var(--text-subtle)'}
              >
                {formatMonthShort(bar.month)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend and readout share a row: two series need naming, and the
          hovered month needs somewhere stable to report itself that does not
          reflow the chart. */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-4">
          <LegendSwatch color="var(--positive)" label="Income" />
          <LegendSwatch color="var(--negative)" label="Spending" />
        </div>
        {activePoint ? (
          <p className="text-text-muted">
            <span className="font-medium text-text">{formatMonth(activePoint.month)}</span>
            {' · saved '}
            <span
              className={cn(
                'nums font-medium',
                activePoint.saved > 0
                  ? 'text-positive'
                  : activePoint.saved < 0
                    ? 'text-negative'
                    : 'text-text-muted',
              )}
            >
              {maskIfPrivate(
                formatCurrency(activePoint.saved, currency, { decimals: 0 }),
                privacyMode,
              )}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-text-muted">
      <span className="size-2.5 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}
