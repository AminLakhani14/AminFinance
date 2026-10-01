/**
 * Daily closes with the trade plan drawn on them.
 *
 * "Buy at 152, sell at 171, stop at 141" only means something against where
 * price has actually been. Drawing the zone, the targets and the stop over the
 * same closes the plan was made from answers that at a glance, and makes an
 * implausible level look implausible instead of authoritative.
 *
 * Reading notes:
 *  - The y-scale spans the history *and* every level, so a stop below the
 *    period's low sits inside the frame rather than being clipped to its edge.
 *  - Levels are labelled directly in a right-hand gutter, nudged apart when
 *    they crowd, so identity never rests on colour alone. The ticket beside
 *    the chart lists every level as text — this is the picture, that is the
 *    table.
 *  - Targets and stop are dashed because they are thresholds, not data.
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { TradeSeriesPoint } from '@aminfinance/shared';

const HEIGHT = 176;
const PLOT_TOP = 10;
/** Room under the plot for the date labels, inside the fixed height. */
const AXIS_BAND = 20;
/** Right-hand column for the level labels. */
const GUTTER = 92;
/** Minimum vertical distance between two gutter labels. */
const LABEL_GAP = 13;

interface Level {
  key: string;
  label: string;
  value: number;
  color: string;
  strong?: boolean;
}

/** Enough digits to tell levels apart at a glance, not to settle an order. */
export function shortPrice(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function axisDate(time: number): string {
  return new Date(time * 1000).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function tooltipDate(time: number): string {
  return new Date(time * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Container width, tracked so text renders at real pixels instead of scaling. */
function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Spread labels so none overlaps another, keeping each as close to its line
 * as the spacing allows: push down where crowded, then pull the stack back up
 * if it ran off the bottom.
 */
function spreadLabels(wanted: number[], top: number, bottom: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed = order.map((o) => Math.min(Math.max(o.y, top), bottom));
  for (let k = 1; k < placed.length; k++) {
    placed[k] = Math.max(placed[k] as number, (placed[k - 1] as number) + LABEL_GAP);
  }
  const overflow = (placed[placed.length - 1] ?? bottom) - bottom;
  if (overflow > 0) {
    placed[placed.length - 1] = bottom;
    for (let k = placed.length - 2; k >= 0; k--) {
      placed[k] = Math.min(placed[k] as number, (placed[k + 1] as number) - LABEL_GAP);
    }
  }
  const out = new Array<number>(wanted.length);
  order.forEach((o, k) => (out[o.i] = placed[k] as number));
  return out;
}

export function TradeChart({
  series,
  buyZone,
  sellTargets,
  stopLoss,
  price,
  currency,
  symbol,
  held,
}: {
  series: TradeSeriesPoint[];
  buyZone: [number, number] | null;
  sellTargets: number[];
  stopLoss: number | null;
  /** Latest price — live when a stream or quote has one, else the plan's. */
  price: number;
  currency: string;
  symbol: string;
  held: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useWidth(containerRef);
  const [active, setActive] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (series.length < 2 || width <= GUTTER + 40) return null;

    const plotW = width - GUTTER;
    const plotBottom = HEIGHT - AXIS_BAND;
    const plotH = plotBottom - PLOT_TOP;

    const levelValues = [...(buyZone ?? []), ...sellTargets, ...(stopLoss !== null ? [stopLoss] : [])];
    const all = [...series.map((p) => p.close), ...levelValues, price].filter(Number.isFinite);
    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = (max - min) * 0.06 || Math.abs(max) * 0.01 || 1;
    const lo = min - pad;
    const hi = max + pad;

    const y = (v: number): number => PLOT_TOP + (1 - (v - lo) / (hi - lo)) * plotH;
    const x = (i: number): number => (i / (series.length - 1)) * plotW;

    const path = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`)
      .join(' ');
    const area = `${path} L${plotW.toFixed(1)},${plotBottom} L0,${plotBottom} Z`;

    const levels: Level[] = [
      ...sellTargets.map((t, i) => ({
        key: `t${i}`,
        label: sellTargets.length > 1 ? `Sell ${i + 1}` : 'Sell',
        value: t,
        color: 'var(--positive)',
      })),
      ...(buyZone
        ? [
            {
              key: 'buy',
              label: held ? 'Add' : 'Buy',
              value: (buyZone[0] + buyZone[1]) / 2,
              color: 'var(--accent)',
            },
          ]
        : []),
      ...(stopLoss !== null
        ? [{ key: 'stop', label: 'Stop', value: stopLoss, color: 'var(--negative)' }]
        : []),
      { key: 'now', label: 'Now', value: price, color: 'var(--viz-1)', strong: true },
    ];
    const labelY = spreadLabels(
      levels.map((l) => y(l.value)),
      PLOT_TOP + 4,
      plotBottom - 4,
    );

    return { plotW, plotBottom, y, x, path, area, levels, labelY };
  }, [series, width, buyZone, sellTargets, stopLoss, price, held]);

  const gradientId = `trade-${symbol.replace(/[^a-zA-Z0-9]/g, '')}`;

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    if (!geometry) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    setActive(Math.round(ratio * (series.length - 1)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setActive((i) => Math.min(Math.max((i ?? series.length - 1) + step, 0), series.length - 1));
  }

  const point = active !== null ? series[active] : undefined;
  const levelSummary = [
    buyZone ? `${held ? 'add' : 'buy'} zone ${shortPrice(buyZone[0])} to ${shortPrice(buyZone[1])}` : null,
    sellTargets.length > 0 ? `sell at ${sellTargets.map(shortPrice).join(', ')}` : null,
    stopLoss !== null ? `stop at ${shortPrice(stopLoss)}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ height: HEIGHT }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setActive(series.length - 1)}
      onBlur={() => setActive(null)}
      aria-label={`${symbol} chart. Use the left and right arrow keys to read daily closes.`}
    >
      {geometry ? (
        <svg
          width={width}
          height={HEIGHT}
          className="block overflow-visible"
          role="img"
          aria-label={`${symbol} daily closes over ${series.length} sessions in ${currency}${levelSummary ? `, with ${levelSummary}` : ''}.`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Recessive grid: solid hairlines, a shade off the surface. */}
          {[0.25, 0.5, 0.75].map((f) => {
            const gy = PLOT_TOP + f * (geometry.plotBottom - PLOT_TOP);
            return (
              <line
                key={f}
                x1={0}
                x2={geometry.plotW}
                y1={gy}
                y2={gy}
                stroke="var(--viz-grid)"
                strokeWidth={1}
              />
            );
          })}
          <line
            x1={0}
            x2={geometry.plotW}
            y1={geometry.plotBottom}
            y2={geometry.plotBottom}
            stroke="var(--viz-axis)"
            strokeWidth={1}
          />

          {/* Zone first, so the price line always sits on top of it. */}
          {buyZone ? (
            <g>
              <rect
                x={0}
                y={geometry.y(buyZone[1])}
                width={geometry.plotW}
                height={Math.max(2, geometry.y(buyZone[0]) - geometry.y(buyZone[1]))}
                fill="var(--accent)"
                fillOpacity={0.14}
              />
              {[buyZone[0], buyZone[1]].map((edge) => (
                <line
                  key={edge}
                  x1={0}
                  x2={geometry.plotW}
                  y1={geometry.y(edge)}
                  y2={geometry.y(edge)}
                  stroke="var(--accent)"
                  strokeOpacity={0.55}
                  strokeWidth={1}
                />
              ))}
            </g>
          ) : null}

          <path d={geometry.area} fill={`url(#${gradientId})`} />
          <path
            d={geometry.path}
            fill="none"
            stroke="var(--viz-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {sellTargets.map((t) => (
            <line
              key={`t-${t}`}
              x1={0}
              x2={geometry.plotW}
              y1={geometry.y(t)}
              y2={geometry.y(t)}
              stroke="var(--positive)"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
          ))}
          {stopLoss !== null ? (
            <line
              x1={0}
              x2={geometry.plotW}
              y1={geometry.y(stopLoss)}
              y2={geometry.y(stopLoss)}
              stroke="var(--negative)"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
          ) : null}

          {/* "You are here", ringed in the surface so it reads over any line. */}
          <circle
            cx={geometry.plotW}
            cy={geometry.y(price)}
            r={4}
            fill="var(--viz-1)"
            stroke="var(--surface)"
            strokeWidth={2}
          />

          {/* Gutter labels, each tied back to its line by a short leader. */}
          {geometry.levels.map((level, i) => {
            const lineY = geometry.y(level.value);
            const ly = geometry.labelY[i] as number;
            const x0 = geometry.plotW + 4;
            return (
              <g key={level.key}>
                <path
                  d={`M${geometry.plotW},${lineY} L${x0},${lineY} L${x0 + 4},${ly}`}
                  fill="none"
                  stroke={level.color}
                  strokeWidth={1}
                />
                <rect x={x0 + 5} y={ly - 1} width={7} height={2} rx={1} fill={level.color} />
                <text
                  x={x0 + 15}
                  y={ly}
                  dominantBaseline="middle"
                  className="nums"
                  fontSize={10}
                  fill={level.strong ? 'var(--text)' : 'var(--text-muted)'}
                  fontWeight={level.strong ? 600 : 400}
                >
                  <tspan fill="var(--text-subtle)">{level.label} </tspan>
                  {shortPrice(level.value)}
                </text>
              </g>
            );
          })}

          {/* Date labels at the start, middle and end of the window. */}
          {[0, Math.floor((series.length - 1) / 2), series.length - 1].map((i, k) => {
            const p = series[i];
            if (!p) return null;
            return (
              <text
                key={`d-${i}`}
                x={geometry.x(i)}
                y={HEIGHT - 6}
                fontSize={10}
                fill="var(--text-subtle)"
                textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
              >
                {axisDate(p.time)}
              </text>
            );
          })}

          {/* Crosshair. */}
          {point && active !== null ? (
            <g pointerEvents="none">
              <line
                x1={geometry.x(active)}
                x2={geometry.x(active)}
                y1={PLOT_TOP}
                y2={geometry.plotBottom}
                stroke="var(--text-subtle)"
                strokeWidth={1}
              />
              <circle
                cx={geometry.x(active)}
                cy={geometry.y(point.close)}
                r={4}
                fill="var(--viz-1)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            </g>
          ) : null}

          {/* Hit area spans the whole plot: readers aim at a date, not a 2px line. */}
          <rect
            x={0}
            y={0}
            width={geometry.plotW}
            height={geometry.plotBottom}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      ) : null}

      {geometry && point && active !== null ? (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] shadow-lg backdrop-blur"
          style={{
            left: Math.min(Math.max(geometry.x(active), 56), geometry.plotW - 56),
          }}
        >
          <p className="text-text-subtle">{tooltipDate(point.time)}</p>
          <p className="nums font-medium text-text">
            {currency} {shortPrice(point.close)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
