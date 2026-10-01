/**
 * Trading desk DTOs.
 *
 * The AI suggestions page answers "where should the next rupee go?" by ranking.
 * The trading desk answers a narrower, more concrete question per asset: *at
 * what price do I buy, at what price do I sell, where am I wrong — and is this
 * something to own for years or only to trade?*
 *
 * Levels come from the model; every number derived from them (upside, risk,
 * reward-to-risk, whether price is in the buy zone) is computed server-side, so
 * the client never displays arithmetic the model did.
 *
 * The JSON schema the model is held to lives in `server/src/providers/aiTrading.ts`
 * and must stay in sync with `TradePlan`.
 */
import type { AssetClass } from './market.js';
import type { ConfidenceLevel, TechnicalSnapshot } from './ai.js';

/**
 * What to do right now.
 *
 * Split by whether the investor holds the asset, because the sensible moves
 * differ: someone flat can buy or stay out, someone holding can add, sit, take
 * profit or exit. The server coerces a signal from the wrong half into its
 * counterpart rather than letting "avoid" reach a position you already own.
 */
export type TradeSignal =
  /** Not held: price is inside the buy zone today. */
  | 'buy-now'
  /** Not held: a good setup, but the buy zone sits below today's price. */
  | 'buy-on-dip'
  /** Not held: no favourable setup — stay out. */
  | 'avoid'
  /** Held: buy more in the buy zone. */
  | 'add'
  /** Held: keep the position exactly as it is. */
  | 'hold'
  /** Held: sell part of the position at the sell targets. */
  | 'take-profit'
  /** Held: exit the position. */
  | 'sell';

/**
 * How long the position deserves to be kept.
 *
 * `long-term` is the answer to "should I just hold this?" — a core holding
 * whose swings are noise. `short-term` means it is a trade, not an investment:
 * buy the zone, sell the targets, and respect the stop.
 */
export type HoldPeriod = 'long-term' | 'medium-term' | 'short-term';

/** Where the latest price sits against the buy zone. */
export type ZoneStatus = 'in-zone' | 'above' | 'below';

/**
 * Where the AI's review of a plan stands.
 *
 * Every plan is computed instantly by the server's chart engine; the model
 * reviews it in the background and its verdict replaces the engine's text
 * when it lands. `skipped` is a deliberate non-review — a market "avoid" with
 * no levels has nothing for the model to weigh.
 */
export type AiReviewStatus = 'ready' | 'pending' | 'failed' | 'skipped';

export interface TradeAiState {
  status: AiReviewStatus;
  /**
   * The chart engine's signal, present only when the review changed it — so
   * the card can say "the AI overrode a buy" rather than silently swapping.
   */
  engineSignal: TradeSignal | null;
  model: string | null;
  generatedAt: number | null;
  error: string | null;
}

/** One close on the plan's chart. `time` is epoch seconds. */
export interface TradeSeriesPoint {
  time: number;
  close: number;
}

/**
 * Numbers derived from the plan's levels — never asked of the model.
 *
 * Measured from the entry: the buy-zone midpoint for a position not yet open,
 * today's price for one already held (or when there is no zone).
 */
export interface TradePlanMetrics {
  /** Percent from the entry to the first sell target above it. */
  upsidePercent: number | null;
  /** Percent from the entry to the stop. Negative. */
  downsidePercent: number | null;
  /**
   * First target's distance above entry divided by the stop's distance below
   * it. Entry is the buy-zone midpoint for a new position, or today's price
   * for one already held. Only set for signals that put money in — buy-now,
   * buy-on-dip and add.
   */
  rewardRisk: number | null;
  zoneStatus: ZoneStatus | null;
  /** How far price must fall to reach the top of the buy zone, in percent. */
  distanceToZonePercent: number | null;
}

export interface TradePlan {
  symbol: string;
  assetClass: AssetClass;
  /** The asset's own quote currency — PKR for PSX, USDT for a Binance pair. */
  currency: string;
  /** Issuer name for PSX equities; null where there is none. */
  name: string | null;
  /** Price the plan was made against. */
  price: number;
  changePercent: number;
  /** Daily closes, oldest first, downsampled for the card's chart. */
  series: TradeSeriesPoint[];

  held: boolean;
  /** Present only when held. `pnlPercent` is null when the cost is unknown. */
  position: { quantity: number; averageCost: number; pnlPercent: number | null } | null;

  signal: TradeSignal;
  holdPeriod: HoldPeriod;
  confidence: ConfidenceLevel;

  /** Buy between these two prices, low then high. Null when no entry is advisable. */
  buyZone: [number, number] | null;
  /** Take-profit prices, ascending. */
  sellTargets: number[];
  /** Where the plan is proven wrong. Always below the entry. */
  stopLoss: number | null;

  metrics: TradePlanMetrics;

  /** What to do and why, for someone who has never read a chart. */
  summary: string;
  /** Whether this is worth owning for years, and why. */
  longTermView: string;
  /** The auditable reasoning: which support, average or ATR each level came from. */
  technicalNote: string;
  /** What would make the plan wrong. */
  invalidation: string;

  /**
   * Short chart facts computed by the server's screen — "Uptrend", "RSI 46",
   * "Near support". Deterministic, so they read the same on every refresh.
   */
  tags: string[];
  technicals: TechnicalSnapshot | null;
  /**
   * The AI review. Levels always come from the chart engine; when the review
   * is ready, `signal`, `holdPeriod`, `confidence`, `summary` and
   * `longTermView` above are the model's.
   */
  ai: TradeAiState;
}

/** Breadth and benchmark for one market, as fed to the model. */
export interface MarketPulse {
  assetClass: AssetClass;
  advancers: number;
  decliners: number;
  unchanged: number;
  /** BTCUSDT for crypto. PSX has no index feed here, so breadth stands alone. */
  benchmark: {
    symbol: string;
    trend: TechnicalSnapshot['trend'];
    rsi14: number | null;
    changePercent30d: number | null;
  } | null;
}

export type TradingScope = 'holdings' | 'market';

export interface TradingDesk {
  scope: TradingScope;
  plans: TradePlan[];
  /** Two or three sentences on what the market is doing today. */
  marketView: string;
  pulse: MarketPulse[];
  /**
   * For a market scan: how many instruments were screened per class and how
   * many made the shortlist the model saw. Empty for holdings.
   */
  screened: Array<{ assetClass: AssetClass; universe: number; shortlisted: number }>;
  /** Symbols that could not be priced or planned, and why. Never silent. */
  skipped: Array<{ symbol: string; reason: string }>;
  /** Reviews still running. The client polls while this is above zero. */
  aiPending: number;
  generatedAt: number;
  /** The model doing the reviews, or null when AI is not configured. */
  model: string | null;
}

/**
 * Where `price` sits against a buy zone.
 *
 * Shared so the server's verdict at generation time and the client's re-check
 * against a live tick can never disagree about what "in the zone" means.
 */
export function zoneStatusOf(price: number, zone: [number, number] | null): ZoneStatus | null {
  if (!zone || !Number.isFinite(price)) return null;
  if (price > zone[1]) return 'above';
  if (price < zone[0]) return 'below';
  return 'in-zone';
}

/** Request body for `POST /api/ai/trading`. */
export interface TradingRequest {
  scope: TradingScope;
  /**
   * The investor's book. Planned in `holdings` scope; in `market` scope it only
   * excludes what is already owned from the scan.
   */
  holdings: Array<{
    symbol: string;
    assetClass: AssetClass;
    quantity: number;
    /** Zero means "cost unknown", not "free". */
    averageCost: number;
  }>;
  /** Market scope only: which classes to scan. Defaults to stocks and crypto. */
  assetClasses?: AssetClass[];
  /** Bypass the server cache. */
  refresh?: boolean;
}
