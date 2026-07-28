/**
 * A single headline number.
 *
 * Per the form heuristic: when the data's job is "one number", the right form
 * is not a chart. A KPI row of these beats a bar chart of four values.
 *
 * The delta pairs an arrow with the signed figure, so direction never depends
 * on colour alone.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPercent } from '@/lib/format';

interface StatTileProps {
  label: string;
  value: string;
  /** Signed change. Omit when the metric has no direction. */
  delta?: number | null | undefined;
  deltaLabel?: string | undefined;
  /**
   * Secondary line under the value. Explicitly allows `undefined` so callers
   * can pass a conditional without tripping exactOptionalPropertyTypes.
   */
  hint?: string | undefined;
  className?: string | undefined;
}

export function StatTile({ label, value, delta, deltaLabel, hint, className }: StatTileProps) {
  const hasDelta = delta !== undefined && delta !== null && Number.isFinite(delta);
  const up = hasDelta && delta > 0;
  const down = hasDelta && delta < 0;

  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs font-medium text-text-muted">{label}</p>
      {/* Hero figures use proportional digits; tabular is for aligned columns. */}
      <p className="mt-1 truncate text-xl font-semibold tracking-tight text-text">{value}</p>

      {hasDelta ? (
        <p
          className={cn(
            'mt-0.5 flex items-center gap-1 text-xs font-medium nums',
            up ? 'text-positive' : down ? 'text-negative' : 'text-text-muted',
          )}
        >
          {up ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : down ? (
            <ArrowDown className="size-3" aria-hidden />
          ) : null}
          <span>
            {deltaLabel ?? formatPercent(delta)}
          </span>
        </p>
      ) : hint ? (
        <p className="mt-0.5 text-xs text-text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}
