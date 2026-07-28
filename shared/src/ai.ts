/**
 * AI insight DTOs.
 *
 * `AssetInsight` and `PortfolioReview` are produced via Claude's structured
 * outputs (JSON schema), so the client renders typed components rather than
 * parsing prose. The JSON schemas live server-side in `providers/claude.ts`
 * and must stay in sync with these interfaces.
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
  /** Epoch ms the market data was read. */
  asOf: number;
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
