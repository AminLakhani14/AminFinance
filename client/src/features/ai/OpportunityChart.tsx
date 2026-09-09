/**
 * Price history with the proposed levels drawn on it.
 *
 * A number like "stop 550.07" means nothing on its own — the question is always
 * *where is that relative to where price has actually been*. Drawing the entry
 * band, targets and stop onto the same series the analysis used answers that at
 * a glance, and makes an implausible level obvious rather than authoritative.
 *
 * The y-scale spans price history **and** every level, so a stop below the
 * 90-day low still appears inside the frame instead of being silently clipped
 * to the edge and reading as "just below".
 */
import { useMemo } from 'react';
import type { TradeLevels } from '@aminfinance/shared';

const WIDTH = 260;
const HEIGHT = 64;
/** Room for the level lines to sit inside the frame. */
const PAD_Y = 4;

export function OpportunityChart({
  series,
  levels,
  price,
  symbol,
}: {
  series: number[];
  levels: TradeLevels | null;
  price: number;
  symbol: string;
}) {
  const geometry = useMemo(() => {
    if (series.length < 2) return null;

    const levelValues = [
      ...(levels?.entryZone ?? []),
      ...(levels?.targets ?? []),
      ...(levels?.stopLoss !== null && levels?.stopLoss !== undefined ? [levels.stopLoss] : []),
    ].filter((v) => Number.isFinite(v));

    const all = [...series, ...levelValues, price];
    const min = Math.min(...all);
    const max = Math.max(...all);
    const range = max - min || 1;

    const usableH = HEIGHT - PAD_Y * 2;
    const y = (value: number): number => PAD_Y + usableH - ((value - min) / range) * usableH;
    const x = (i: number): number => (i / (series.length - 1)) * WIDTH;

    const path = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    // Close the shape down to the baseline for the subtle area fill.
    const area = `${path} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;

    return { y, path, area, first: series[0] as number, last: series[series.length - 1] as number };
  }, [series, levels, price]);

  if (!geometry) return null;

  const rising = geometry.last >= geometry.first;
  const stroke = rising ? 'var(--positive)' : 'var(--negative)';
  const gradientId = `spark-${symbol.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="h-16 w-full max-w-[260px] overflow-visible"
      role="img"
      aria-label={`${symbol} price over the last ${series.length} sessions, with suggested levels`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Entry band first, so the price line always sits on top of it. */}
      {levels?.entryZone ? (
        <rect
          x={0}
          y={Math.min(geometry.y(levels.entryZone[0]), geometry.y(levels.entryZone[1]))}
          width={WIDTH}
          height={Math.max(
            1.5,
            Math.abs(geometry.y(levels.entryZone[0]) - geometry.y(levels.entryZone[1])),
          )}
          fill="var(--accent)"
          fillOpacity={0.16}
        />
      ) : null}

      <path d={geometry.area} fill={`url(#${gradientId})`} />
      <path d={geometry.path} fill="none" stroke={stroke} strokeWidth={1.5} />

      {levels?.targets.map((t) => (
        <line
          key={`t-${t}`}
          x1={0}
          x2={WIDTH}
          y1={geometry.y(t)}
          y2={geometry.y(t)}
          stroke="var(--positive)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.75}
        />
      ))}

      {levels?.stopLoss !== null && levels?.stopLoss !== undefined ? (
        <line
          x1={0}
          x2={WIDTH}
          y1={geometry.y(levels.stopLoss)}
          y2={geometry.y(levels.stopLoss)}
          stroke="var(--negative)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.85}
        />
      ) : null}

      {/* Current price, so the eye lands on "you are here" before the levels. */}
      <circle cx={WIDTH} cy={geometry.y(price)} r={2.5} fill={stroke} />
    </svg>
  );
}
