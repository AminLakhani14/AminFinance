/**
 * Display formatting.
 *
 * Financial figures are rendered with tabular figures (`.nums`) elsewhere;
 * this module decides precision and grouping. The guiding rule is that a
 * number should never imply more precision than the underlying data has.
 */

/** Crypto needs far more decimals than fiat — 0.00306088 BTC is a real position. */
export function formatQuantity(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  // Small crypto balances: show enough digits to be meaningful.
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function formatCurrency(
  value: number,
  currency: string,
  options: { compact?: boolean; decimals?: number } = {},
): string {
  const { compact = false, decimals } = options;

  if (compact && Math.abs(value) >= 1_000_000) {
    return `${currency} ${compactNumber(value)}`;
  }

  const fractionDigits =
    decimals ??
    // Sub-unit prices (XRP at 1.09, small caps) need more than 2 decimals to
    // be useful; large values do not.
    (Math.abs(value) < 1 && value !== 0 ? 4 : 2);

  return `${currency} ${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/** Always signed — the direction matters more than the magnitude when scanning. */
export function formatPercent(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatSigned(value: number, currency: string): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatCurrency(Math.abs(value), currency)}`;
}

/**
 * Direction as a semantic token name, never as a raw colour.
 *
 * Colour alone is not an accessible signal, so every caller pairs this with a
 * sign or arrow.
 */
export function directionClass(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-text-muted';
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "as of" label for cached data — the UI must never pass stale off as live. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Mask amounts for screenshots without changing layout width. */
export function maskIfPrivate(text: string, privacyMode: boolean): string {
  return privacyMode ? '•'.repeat(Math.min(text.length, 10)) : text;
}
