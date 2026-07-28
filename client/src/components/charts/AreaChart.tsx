/**
 * Portfolio value over time.
 *
 * One series, so no legend box — the card title names it. Ships a crosshair +
 * tooltip by default: an SVG chart in a browser *is* interactive, and a static
 * value line invites "what was it in March?" with no way to answer.
 */
import { useMemo, useRef, useState } from 'react';
import { formatCurrency, formatDate } from '@/lib/format';

export interface AreaPoint {
  timestamp: number;
  value: number;
}

interface AreaChartProps {
  data: AreaPoint[];
  currency: string;
  height?: number;
  /** Reference line for cost basis, so gain/loss is readable at a glance. */
  baseline?: number | null;
  className?: string;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

export function AreaChart({
  data,
  currency,
  height = 240,
  baseline = null,
  className,
}: AreaChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Track container width so the chart is responsive without a resize library.
  useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    if (data.length < 2) return null;

    const values = data.map((d) => d.value);
    const min = Math.min(...values, baseline ?? Infinity);
    const max = Math.max(...values, baseline ?? -Infinity);
    // Pad the range so the line never sits on the frame.
    const span = max - min || Math.abs(max) || 1;
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;

    const plotW = Math.max(0, width - PAD.left - PAD.right);
    const plotH = height - PAD.top - PAD.bottom;

    const x = (i: number) => PAD.left + (i / (data.length - 1)) * plotW;
    const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

    const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.value)}`).join(' ');
    const area = `${line} L${x(data.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`;

    // Four ticks is enough to read a level without becoming a table.
    const ticks = [0, 1, 2, 3].map((n) => lo + ((hi - lo) * n) / 3);

    return { x, y, line, area, ticks, plotW, plotH, lo, hi };
  }, [data, width, height, baseline]);

  if (!geometry) {
    return (
      <div
        ref={wrapRef}
        className="flex items-center justify-center text-sm text-text-muted"
        style={{ height }}
      >
        Not enough history yet.
      </div>
    );
  }

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const ratio = (px - PAD.left) / geometry.plotW;
    const index = Math.round(ratio * (data.length - 1));
    setHoverIndex(index >= 0 && index < data.length ? index : null);
  }

  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative' }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`Portfolio value over time, ${data.length} points`}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive grid — present enough to read a level, quiet enough to ignore. */}
        {geometry.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={geometry.y(tick)}
              y2={geometry.y(tick)}
              stroke="var(--viz-grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={geometry.y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="nums"
              fontSize="10"
              fill="var(--text-subtle)"
            >
              {abbreviate(tick)}
            </text>
          </g>
        ))}

        {baseline !== null ? (
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={geometry.y(baseline)}
            y2={geometry.y(baseline)}
            stroke="var(--text-subtle)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ) : null}

        <path d={geometry.area} fill="url(#areaFill)" />
        <path
          d={geometry.line}
          fill="none"
          stroke="var(--viz-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {hovered && hoverIndex !== null ? (
          <g>
            <line
              x1={geometry.x(hoverIndex)}
              x2={geometry.x(hoverIndex)}
              y1={PAD.top}
              y2={PAD.top + geometry.plotH}
              stroke="var(--viz-axis)"
              strokeWidth={1}
            />
            {/* 2px surface ring so the marker reads against the line beneath it. */}
            <circle
              cx={geometry.x(hoverIndex)}
              cy={geometry.y(hovered.value)}
              r={5}
              fill="var(--viz-1)"
              stroke="var(--surface)"
              strokeWidth={2}
            />
          </g>
        ) : null}
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(geometry.x(hoverIndex ?? 0) - 60, 0), width - 130),
            top: 4,
          }}
        >
          <div className="text-text-muted">{formatDate(hovered.timestamp)}</div>
          <div className="nums font-medium text-text">
            {formatCurrency(hovered.value, currency, { compact: true })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function abbreviate(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
}
