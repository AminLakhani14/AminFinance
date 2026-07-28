/**
 * Correlation matrix.
 *
 * Polarity data (−1..+1), so the encoding is **diverging**: two hues with a
 * neutral gray midpoint. A sequential ramp would imply −1 and +1 are opposite
 * ends of one magnitude, when they are opposite *signs* of a relationship.
 *
 * Each cell carries its numeric value, so the reading never depends on colour.
 */
import { divergingColor } from './palette';
import { cn } from '@/lib/utils';

interface HeatmapProps {
  symbols: string[];
  values: number[][];
  className?: string;
}

export function Heatmap({ symbols, values, className }: HeatmapProps) {
  if (symbols.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-text-muted">
        Correlation needs at least two holdings with overlapping price history.
      </p>
    );
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="border-separate border-spacing-0.5 text-xs">
        <caption className="sr-only">
          Correlation matrix of daily returns. 1 means the two move together, −1
          means they move oppositely, 0 means no relationship.
        </caption>
        <thead>
          <tr>
            <th className="p-1" />
            {symbols.map((symbol) => (
              <th
                key={symbol}
                scope="col"
                className="p-1 text-[10px] font-medium text-text-muted"
              >
                {symbol}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {symbols.map((rowSymbol, r) => (
            <tr key={rowSymbol}>
              <th
                scope="row"
                className="whitespace-nowrap p-1 text-right text-[10px] font-medium text-text-muted"
              >
                {rowSymbol}
              </th>
              {symbols.map((colSymbol, c) => {
                const value = values[r]?.[c] ?? 0;
                return (
                  <td
                    key={colSymbol}
                    className="size-11 rounded-sm text-center align-middle"
                    style={{ background: divergingColor(value) }}
                    title={`${rowSymbol} vs ${colSymbol}: ${value.toFixed(2)}`}
                  >
                    {/* Value in ink, not the series colour — the number is the
                        accessible reading; colour is the fast scan. */}
                    <span className="nums text-[11px] font-medium text-text">
                      {value.toFixed(2)}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-text-muted">
        <span>−1 opposite</span>
        <span
          className="h-2 w-24 rounded-full"
          style={{
            background:
              'linear-gradient(to right, var(--viz-diverge-neg), var(--viz-diverge-mid), var(--viz-diverge-pos))',
          }}
          aria-hidden
        />
        <span>+1 together</span>
      </div>
    </div>
  );
}
