/**
 * Where the month's money went.
 *
 * A ranked bar list, not a pie. The question this answers is "what is biggest,
 * and by how much" — length on a common baseline is read accurately at a
 * glance, where twelve pie slices are not. The donut beside it carries the
 * part-to-whole reading; this carries the comparison.
 *
 * Share is printed on every row, so magnitude never depends on bar length
 * alone, and colour is identity-only (fixed slot per category), never the
 * sole carrier of meaning.
 */
import type { CategoryTotal } from '@aminfinance/shared';
import { categoryLabel } from '@/lib/calc/budget';
import { formatCurrency, maskIfPrivate } from '@/lib/format';
import { seriesVar } from '@/components/charts/palette';
import { cn } from '@/lib/utils';

interface CategoryBreakdownProps {
  data: CategoryTotal[];
  currency: string;
  privacyMode: boolean;
  /** Colour per category, so a slice matches its bar across both views. */
  colors: Map<string, string>;
  className?: string;
}

export function CategoryBreakdown({
  data,
  currency,
  privacyMode,
  colors,
  className,
}: CategoryBreakdownProps) {
  if (data.length === 0) {
    return (
      <p className={cn('py-6 text-center text-sm text-text-muted', className)}>
        Nothing recorded yet.
      </p>
    );
  }

  // Bars are scaled against the largest row, not against the total. Scaling to
  // the total would squash every bar into the left edge as categories multiply,
  // which defeats the comparison the list exists for.
  const max = Math.max(...data.map((d) => d.amount));

  return (
    <ul className={cn('space-y-3', className)}>
      {data.map((row, i) => (
        <li key={row.category}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: colors.get(row.category) ?? seriesVar(i) }}
                aria-hidden
              />
              <span className="truncate text-text">{categoryLabel(row.category)}</span>
              <span className="shrink-0 text-xs text-text-subtle nums">
                &times;{row.count}
              </span>
            </span>
            <span className="shrink-0 nums font-medium text-text">
              {maskIfPrivate(formatCurrency(row.amount, currency, { decimals: 0 }), privacyMode)}
            </span>
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <div
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-raised"
              role="img"
              aria-label={`${categoryLabel(row.category)}: ${(row.share * 100).toFixed(1)} percent of the total`}
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${max > 0 ? (row.amount / max) * 100 : 0}%`,
                  background: colors.get(row.category) ?? seriesVar(i),
                }}
              />
            </div>
            <span className="w-11 shrink-0 text-right text-xs text-text-muted nums">
              {(row.share * 100).toFixed(1)}%
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
