/**
 * In-table trend line.
 *
 * One series, so no legend — the row's symbol names it. No axes, no grid, no
 * tooltip: at this size any chrome would outweigh the signal. It reads as a
 * sparkline, which is the point.
 */
import { useMemo } from 'react';

interface SparklineProps {
  values: number[];
  /** Colour by direction — paired with the row's signed % so it isn't colour-alone. */
  direction?: 'up' | 'down' | 'flat';
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  direction = 'flat',
  width = 88,
  height = 28,
  className,
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    // Inset by 1px so a 2px stroke isn't clipped at the extremes.
    const inset = 1;
    const usableH = height - inset * 2;

    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = inset + usableH - ((v - min) / range) * usableH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values, width, height]);

  if (!path) {
    return <div style={{ width, height }} aria-hidden />;
  }

  const stroke =
    direction === 'up'
      ? 'var(--positive)'
      : direction === 'down'
        ? 'var(--negative)'
        : 'var(--text-subtle)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      // Decorative: the adjacent signed percentage is the accessible value.
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
