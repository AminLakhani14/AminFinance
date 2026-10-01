/**
 * Converting between `<input type="date">` values and the epoch-ms timestamps
 * the budget book stores. Shared by the payment log and the month's history,
 * which both let the user pick the day money moved.
 */

/** Local `YYYY-MM-DD` — never `toISOString`, which shifts the day across UTC. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Midday, not midnight, for a `YYYY-MM-DD` the user picked.
 *
 * A date input gives no time, and midnight is one DST shift away from being
 * the previous day — which would file a payment under the wrong date, and at a
 * month boundary under the wrong month.
 */
export function timestampFromInput(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 12).getTime();
}

/**
 * Today when the open month is the current one, else the 1st of that month.
 *
 * Logging into September while it is November should not default to a date
 * outside the month being filled in.
 */
export function defaultDate(month: string, now = new Date()): string {
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month === currentKey) return toDateInput(now);
  return `${month}-01`;
}

/** First and last `YYYY-MM-DD` of a `YYYY-MM`, for a date input's min and max. */
export function monthBounds(month: string): { min: string; max: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(year!, monthNumber!, 0).getDate();
  return { min: `${month}-01`, max: `${month}-${String(lastDay).padStart(2, '0')}` };
}
