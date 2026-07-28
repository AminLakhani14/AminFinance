/**
 * Portfolio domain types.
 *
 * Transactions are the source of truth and live in the browser (IndexedDB).
 * Everything else here is *derived* — computed by selectors from transactions
 * plus live quotes. Nothing derived is ever persisted; that is how trackers
 * end up showing stale P/L.
 *
 * These types are in `shared/` because the server needs them to build AI
 * prompts, not because the server stores them.
 */
import type { AssetClass } from './market.js';

export type TransactionType = 'buy' | 'sell';

/** Where a transaction came from. Binance-sourced rows are not user-editable. */
export type TransactionSource = 'manual' | 'binance' | 'csv';

export interface Transaction {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  type: TransactionType;
  /** Units of the base asset. Always positive; `type` carries the direction. */
  quantity: number;
  /** Price per unit at execution, in `currency`. */
  price: number;
  /** Commission/fee in `currency`. Included in cost basis. */
  fee: number;
  currency: string;
  /** Epoch ms of execution. */
  timestamp: number;
  source: TransactionSource;
  /** Upstream trade id, for dedup on re-sync. Binance-sourced rows only. */
  externalId?: string;
  notes?: string;
}

/** An open tax lot — one buy, partially or fully unsold. */
export interface Lot {
  transactionId: string;
  /** Units still open (original quantity minus what later sells consumed). */
  remainingQuantity: number;
  /** Per-unit cost including the fee share allocated to this lot. */
  costPerUnit: number;
  acquiredAt: number;
}

/** A live position: transactions collapsed by symbol, priced with a quote. */
export interface Holding {
  symbol: string;
  assetClass: AssetClass;
  quantity: number;
  /** Weighted-average cost per unit, fees included. */
  averageCost: number;
  /** `quantity * averageCost` — what you actually paid. */
  costBasis: number;
  /** Live price from the most recent quote. */
  currentPrice: number;
  /** `quantity * currentPrice`. */
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  /** Value change since the previous close. */
  dayChange: number;
  dayChangePercent: number;
  /** Share of total portfolio market value, 0–100. */
  allocationPercent: number;
  currency: string;
  openLots: Lot[];
}

/** Realized gain from a closed (or partially closed) position. */
export interface RealizedGain {
  symbol: string;
  assetClass: AssetClass;
  quantity: number;
  proceeds: number;
  costBasis: number;
  /** `proceeds - costBasis`, fees already deducted from both sides. */
  gain: number;
  gainPercent: number;
  closedAt: number;
  /** Days between acquisition and disposal — drives long/short-term treatment. */
  holdingPeriodDays: number;
}

/** Whole-portfolio rollup. */
export interface PortfolioSummary {
  totalValue: number;
  totalCostBasis: number;
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPercent: number;
  totalRealizedPnl: number;
  dayChange: number;
  dayChangePercent: number;
  /** Display currency everything above was converted into. */
  currency: string;
  holdingsCount: number;
  /** Epoch ms of the quote snapshot these numbers were computed from. */
  asOf: number;
}

/** A single point on the portfolio value history chart. */
export interface PortfolioSnapshot {
  /** Epoch ms, normalized to end-of-day UTC. */
  timestamp: number;
  totalValue: number;
  totalCostBasis: number;
}

/** Risk and performance metrics for the Analytics page. */
export interface PortfolioMetrics {
  /** Annualized standard deviation of daily returns, as a percent. */
  volatility: number | null;
  /** Annualized, using the configured risk-free rate. */
  sharpeRatio: number | null;
  /** Largest peak-to-trough decline, as a negative percent. */
  maxDrawdown: number | null;
  /** Best and worst holdings by unrealized P/L percent. */
  bestPerformer: { symbol: string; pnlPercent: number } | null;
  worstPerformer: { symbol: string; pnlPercent: number } | null;
  /** Symmetric matrix of return correlations, -1..1. Row/col order = `symbols`. */
  correlationMatrix: { symbols: string[]; values: number[][] } | null;
}
