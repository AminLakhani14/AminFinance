/**
 * AI insight DTOs.
 *
 * `AssetInsight` and `PortfolioReview` are produced via structured outputs
 * (JSON schema) from an OpenAI-compatible model, so the client renders typed
 * components rather than parsing prose. The JSON schemas live server-side in
 * `providers/ai.ts` and must stay in sync with these interfaces.
 */
import type { AssetClass } from './market.js';

export type Verdict = 'buy' | 'hold' | 'reduce' | 'sell';

/** Confidence as a band, not a false-precision number. */
export type ConfidenceLevel = 'low' | 'moderate' | 'high';

export type TimeHorizon = 'short' | 'medium' | 'long';

/** A single reasoned point in the bull or bear case. */
export interface InsightPoint {
  /** Short label for the card header, e.g. "Margin expansion". */
  title: string;
  /** One to three sentences of reasoning. */
  detail: string;
}

export interface AssetInsight {
  symbol: string;
  assetClass: AssetClass;
  verdict: Verdict;
  confidence: ConfidenceLevel;
  horizon: TimeHorizon;
  /** Two-sentence summary shown collapsed on the card. */
  summary: string;
  bullCase: InsightPoint[];
  bearCase: InsightPoint[];
  risks: InsightPoint[];
  /**
   * How this reads against the user's actual position (cost basis, size,
   * allocation) rather than the asset in the abstract.
   */
  positionNote: string | null;
  /**
   * Proposed entry, targets, and stop. Null when the model declines to give
   * levels — which is the right answer for a chart with too little history.
   */
  levels: TradeLevels | null;
  /** How the chart itself reads: trend, momentum, and where price sits. */
  chartRead: string | null;
  /** The exact data the model was given — shown in the UI for auditability. */
  basedOn: InsightDataSnapshot;
  /** Epoch ms the insight was generated. */
  generatedAt: number;
  model: string;
}

/**
 * The factual snapshot passed into the prompt. Surfaced in the UI so a stale
 * or thin insight is visibly attributable to stale or thin inputs.
 */
export interface InsightDataSnapshot {
  price: number;
  currency: string;
  changePercent: number;
  marketCap: number | null;
  peRatio: number | null;
  dividendYield: number | null;
  /** Present only when the user holds the asset. */
  userCostBasis: number | null;
  userQuantity: number | null;
  userPnlPercent: number | null;
  /** Headlines fed to the model, for provenance. */
  headlines: string[];
  /** Chart state, or null when too few candles exist to compute it. */
  technicals: TechnicalSnapshot | null;
  /** Epoch ms the market data was read. */
  asOf: number;
}

/**
 * Indicator readings over the daily series, computed server-side and passed
 * into the prompt so the model reasons about the chart rather than guessing at
 * it from a single price.
 *
 * Every field is nullable: a newly listed ticker has no 200-day average, and
 * reporting one anyway — from 30 bars, say — would be worse than admitting the
 * gap. `bars` is surfaced so a thin reading is visibly thin.
 */
export interface TechnicalSnapshot {
  /** Daily bars available to the calculation. */
  bars: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  /** Wilder's RSI over 14 periods. Above 70 overbought, below 30 oversold. */
  rsi14: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  /** 20-period band at 2 standard deviations. `percentB` is 0 at the lower
   *  band and 1 at the upper. */
  bollinger: { upper: number; middle: number; lower: number; percentB: number } | null;
  /** Average true range over 14 periods, and the same as a share of price so
   *  volatility is comparable between a PKR equity and a dollar coin. */
  atr14: number | null;
  atrPercent: number | null;
  high52w: number | null;
  low52w: number | null;
  /** Where price sits in the 52-week range: 0 at the low, 1 at the high. */
  rangePosition: number | null;
  /** Nearest swing pivots below and above the current price. */
  support: number | null;
  resistance: number | null;
  trend: 'up' | 'down' | 'sideways';
  changePercent7d: number | null;
  changePercent30d: number | null;
  changePercent90d: number | null;
}

/** Price levels the model proposes. Advisory, and always nullable. */
export interface TradeLevels {
  /** Price range worth accumulating in, low then high. */
  entryZone: [number, number] | null;
  /** Ordered take-profit levels. */
  targets: number[];
  /** Level at which the thesis is wrong. */
  stopLoss: number | null;
  /** Why these levels and not others — tied to support, resistance, or ATR. */
  rationale: string;
}

export interface ConcentrationFlag {
  symbol: string;
  allocationPercent: number;
  /** Why this concentration is worth attention. */
  note: string;
}

export interface RebalanceSuggestion {
  symbol: string;
  action: 'increase' | 'decrease' | 'maintain';
  /** Suggested target as a percent of portfolio, or null for directional-only. */
  targetPercent: number | null;
  rationale: string;
}

export interface PortfolioReview {
  summary: string;
  /** Qualitative read on how diversified the book is. */
  diversification: {
    assessment: string;
    score: ConfidenceLevel;
    gaps: string[];
  };
  concentrationFlags: ConcentrationFlag[];
  rebalancing: RebalanceSuggestion[];
  risks: InsightPoint[];
  generatedAt: number;
  model: string;
}

/**
 * One asset's place in a ranked comparison.
 *
 * `action` is deliberately five-valued rather than reusing `Verdict`: ranking a
 * book you already hold needs "accumulate" (add to a winner) to be distinct
 * from "buy" (open a new position), and the two read very differently to
 * someone deciding where the next rupee goes.
 */
export interface Opportunity {
  symbol: string;
  assetClass: AssetClass;
  /**
   * Currency the price and every level below are quoted in.
   *
   * Per-asset, not the portfolio's display currency: a PSX equity is priced in
   * PKR and a Binance pair in USDT, and labelling a USDT stop as PKR turns an
   * advisory number into a misleading one.
   */
  currency: string;
  /** Latest price, so levels can be read against it without a second lookup. */
  price: number;
  /**
   * Recent daily closes, oldest first, for the row's chart. Downsampled
   * server-side from the same candles the indicators used, so the client draws
   * the chart the analysis was based on rather than refetching its own.
   */
  series: number[];
  /** Whether the investor already holds it — drives which actions are sensible. */
  held: boolean;
  action: 'buy' | 'accumulate' | 'hold' | 'reduce' | 'sell';
  conviction: ConfidenceLevel;
  horizon: TimeHorizon;
  /** 1 is the most attractive. Unique across the set. */
  rank: number;
  /** Two sentences at most, tied to the data. */
  rationale: string;
  /**
   * The same call in everyday language, for a reader who does not know what
   * RSI or a moving average is.
   *
   * A separate field rather than a rewrite of `rationale`: the technical
   * version is what makes the call auditable, and collapsing the two would
   * either strip the evidence or leave the plain version hedged and vague.
   */
  plainEnglish: string;
  levels: TradeLevels | null;
  /** How much to move, and by when. Null when the action is `hold`. */
  sizing: PositionSizing | null;
  /**
   * Issuer facts behind the call, so the card can show why without a second
   * request. Null for crypto and commodities, which have no issuer.
   */
  profile: OpportunityProfile | null;
  /** 52-week range and day move — context for the price, any asset class. */
  priceContext: PriceContext | null;
}

/** Issuer-level facts. PSX equities only. */
export interface OpportunityProfile {
  name: string;
  marketCap: number | null;
  peRatio: number | null;
  epsTtm: number | null;
  /** Trailing yield as a percentage, when the exchange reports one. */
  dividendYield: number | null;
  sector: string | null;
  /**
   * Payout record, parsed from the exchange's payouts table.
   *
   * Carried on the ranking row so a dividend-driven call ("hold it for the
   * yield") can show the payouts it rests on without a second request.
   */
  dividends: DividendSummary | null;
}

/**
 * What an issuer has paid and what it has announced.
 *
 * Amounts are per share in the issuer's currency, already converted from the
 * exchange's percent-of-par quoting — PSX publishes "250%", meaning PKR 25 on
 * a PKR 10 par value, which is not a yield and must never be shown as one.
 */
export interface DividendSummary {
  /** The next announced payout, or null when none is scheduled. */
  next: { exDate: string; amount: number; period: string | null } | null;
  /** Past payouts, newest first. */
  history: Array<{ exDate: string; amount: number; period: string | null }>;
  /** Sum of the last twelve months' payouts, per share. */
  trailingAnnualAmount: number | null;
  /** Trailing amount as a percentage of the current price. */
  trailingYieldPercent: number | null;
}

export interface PriceContext {
  changePercent: number;
  weekHigh52: number | null;
  weekLow52: number | null;
}

/**
 * The size of the suggested move.
 *
 * Expressed as a share of the *book*, not of the position, because that is the
 * decision actually being made — "put 5% of the portfolio here" survives a
 * changing balance, whereas "buy 200 shares" is stale the moment prices move
 * and meaningless without knowing the total.
 *
 * `units` and `amount` are derived server-side from that percentage at the
 * current price, so the client never multiplies numbers the model invented.
 */
export interface PositionSizing {
  /**
   * Percentage points of the total book to add (positive) or remove
   * (negative). An `accumulate` of +3 on a 100,000 book means ~3,000 in.
   */
  deltaPercentOfBook: number;
  /** Target weight once the move is complete, 0-100. */
  targetAllocationPercent: number;
  /** Units to trade at the current price. Sign matches `deltaPercentOfBook`. */
  units: number;
  /** Cash value of the move in the asset's own currency. Always positive. */
  amount: number;
  /** Whether to move all at once or scale in — and over what period. */
  pacing: 'now' | 'staged' | 'on-dip';
  /** One sentence on why this size: conviction, concentration, or risk. */
  rationale: string;
}

export interface OpportunitySet {
  opportunities: Opportunity[];
  /** What is true across the whole set — regime, correlation, currency. */
  marketNote: string;
  /** Symbols that could not be priced, and why. Surfaced, never silent. */
  skipped: Array<{ symbol: string; reason: string }>;
  generatedAt: number;
  model: string;
}

/** Request body for `POST /api/ai/opportunities`. */
export interface OpportunitiesRequest {
  holdings: Array<{
    symbol: string;
    assetClass: AssetClass;
    quantity: number;
    averageCost: number;
    allocationPercent: number;
  }>;
  /** Symbols to weigh up alongside the book, though not currently held. */
  candidates?: string[];
  /**
   * Restrict the ranking to one asset class.
   *
   * The page ranks stocks, coins and metals in three separate calls so each
   * section gets its own 1..N ordering, rather than one global ranking whose
   * numbers skip within a section. Holdings and candidates of other classes
   * are filtered out server-side, and the cache key includes this, so the
   * three results are cached independently.
   *
   * Omit it to rank everything together, which is still what the portfolio
   * review does.
   */
  assetClass?: AssetClass;
  currency: string;
  /**
   * Total portfolio value in `currency`. Lets the server express sizing in
   * units and cash instead of bare percentages. Omit it and sizing still
   * works, just without absolute figures.
   */
  bookValue?: number;
  /**
   * Cash the investor can actually commit each month, in `currency`.
   *
   * Derived from the budget book's dependable surplus — the median monthly
   * saving less its variance. Without it, sizing is expressed as a share of
   * the existing book, which answers "how should this be weighted" but not
   * "what can I buy next month". A 3%-of-book suggestion on a 200,000 book is
   * 6,000, and whether that is affordable is a budget question the ranking
   * otherwise has no way to ask.
   *
   * Optional, and absent whenever there is too little budget history to
   * establish a rate — in which case the model must size against the book
   * alone rather than assume a figure.
   */
  investableSurplus?: number;
  /** Rate from each asset currency into `currency`, keyed by currency code. */
  fxToDisplay?: Record<string, number>;
  refresh?: boolean;
}

/** Request body for `POST /api/ai/analyze`. */
export interface AnalyzeRequest {
  symbol: string;
  assetClass: AssetClass;
  /** Omit when the user does not hold the asset (watchlist analysis). */
  position?: {
    quantity: number;
    averageCost: number;
  };
  /** Bypass the 24h server cache. Rate-limited harder. */
  refresh?: boolean;
}

/** Request body for `POST /api/ai/portfolio-review`. */
export interface PortfolioReviewRequest {
  holdings: Array<{
    symbol: string;
    assetClass: AssetClass;
    quantity: number;
    averageCost: number;
    allocationPercent: number;
  }>;
  currency: string;
  refresh?: boolean;
}
