/**
 * Macroeconomic context for Pakistan.
 *
 * Separate from `market.ts` because these are not instruments: nothing here is
 * priced, tradable, or ownable. They are the backdrop a PKR-denominated
 * portfolio sits against — a 12% CPI print and a sliding rupee change what a
 * nominal PSX gain actually means.
 *
 * Every figure carries its own `asOf` and `source` rather than the payload
 * carrying one timestamp for all of them. The series genuinely disagree on
 * recency: the USD/PKR rate is hours old while World Bank reserves can be a
 * year behind, and a single "as of" line would misrepresent one of them.
 */

/** Series that update on different clocks, so they are labelled individually. */
export type IndicatorPeriod = 'daily' | 'monthly' | 'annual';

/**
 * How the tab groups the tiles. Purely presentational, but kept server-side so
 * the grouping does not drift between the payload and the page.
 */
export type IndicatorGroup = 'external' | 'trade' | 'prices' | 'activity';

export interface EconomyIndicator {
  /** Stable key — `reserves.total`, `fx.usdpkr`. Used for React keys. */
  id: string;
  label: string;
  group: IndicatorGroup;
  /**
   * The figure itself, in `unit`. Null when the upstream has the series but no
   * observation for it — a tile that reads "—" is honest; a zero is not.
   */
  value: number | null;
  /** `USD`, `PKR`, `%`, or `PKR/USD`. Drives formatting, so it is not free text. */
  unit: 'USD' | 'PKR' | '%' | 'PKR/USD';
  /**
   * Change against the previous observation in the same series, as a percent.
   * Null when there is no prior point to compare against, or when the metric
   * is itself a rate (an inflation rate's percent change reads as nonsense).
   */
  changePercent: number | null;
  /**
   * What `changePercent` is measured against, in words: `year on year`, or
   * `vs 2024`.
   *
   * The basis genuinely differs per indicator — monthly trade is compared to
   * the same month a year earlier, annual series to the prior year — and a
   * bare percentage that hides which one it used is the kind of number a
   * reader trusts and should not.
   */
  changeBasis: string | null;
  /** Epoch ms of the observation — not of the fetch. */
  asOf: number;
  /** Human label for the observation's period: "2025", "Sep 2026". */
  periodLabel: string;
  period: IndicatorPeriod;
  /** Attribution, shown in the UI. These are public figures; the source matters. */
  source: string;
  /**
   * Oldest-first history for the sparkline. Empty when the series is a single
   * live reading (the FX rate) rather than a tracked series.
   */
  history: Array<{ periodLabel: string; value: number }>;
  /** Shown under the tile when the figure needs a caveat to be read correctly. */
  note?: string | null;
}

export interface EconomySnapshot {
  country: 'PK';
  indicators: EconomyIndicator[];
  /** Epoch ms the snapshot was assembled. Distinct from any observation date. */
  asOf: number;
  /**
   * Series that could not be fetched, keyed by indicator id. Surfaced rather
   * than swallowed: a missing reserves figure should read as "unavailable",
   * never as an empty tile the user mistakes for zero.
   */
  errors?: Record<string, string>;
}
