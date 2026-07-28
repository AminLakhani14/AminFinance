/**
 * Chart palette accessors.
 *
 * Series colours are read from CSS custom properties so light/dark swap in one
 * place and the chart body is written against roles, not raw hex.
 *
 * The slot order is the colorblind-safety mechanism — validated adjacent-pair
 * separation in both modes — so hues are assigned in fixed order and **never
 * cycled**. Past slot 8, series fold into "Other" rather than repeating a hue,
 * because a repeated colour means two different things on one chart.
 */

export const MAX_SERIES = 8;

/** Fixed slot order. Index 0 is slot 1. */
export function seriesVar(index: number): string {
  return `var(--viz-${Math.min(index + 1, MAX_SERIES)})`;
}

/**
 * Assign colours to entities by identity, not by rank.
 *
 * Keyed on the symbol so filtering or re-sorting never repaints the survivors —
 * FFC stays the same colour whether it is first or fourth in the list.
 */
export function buildColorMap(symbols: string[]): Map<string, string> {
  const map = new Map<string, string>();
  symbols.slice(0, MAX_SERIES).forEach((symbol, i) => map.set(symbol, seriesVar(i)));
  return map;
}

/**
 * Collapse a long series list into the top N plus "Other".
 *
 * Generating a 9th hue would break the validated palette, so the honest move is
 * to aggregate.
 */
export function foldToOther<T extends { symbol: string; value: number }>(
  items: T[],
  max = MAX_SERIES,
): Array<{ symbol: string; value: number; isOther: boolean }> {
  if (items.length <= max) {
    return items.map((i) => ({ symbol: i.symbol, value: i.value, isOther: false }));
  }
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  return [
    ...head.map((i) => ({ symbol: i.symbol, value: i.value, isOther: false })),
    { symbol: 'Other', value: tail.reduce((s, i) => s + i.value, 0), isOther: true },
  ];
}

/**
 * Diverging scale for correlation, −1..+1.
 *
 * Two hues with a neutral gray midpoint — a rainbow or a hued midpoint would
 * imply structure that isn't in the data.
 */
export function divergingColor(value: number): string {
  const clamped = Math.max(-1, Math.min(1, value));
  if (Math.abs(clamped) < 0.05) return 'var(--viz-diverge-mid)';
  const magnitude = Math.abs(clamped);
  const hue = clamped > 0 ? 'var(--viz-diverge-pos)' : 'var(--viz-diverge-neg)';
  // Opacity carries magnitude; hue carries sign.
  return `color-mix(in oklab, ${hue} ${Math.round(magnitude * 100)}%, var(--viz-diverge-mid))`;
}
