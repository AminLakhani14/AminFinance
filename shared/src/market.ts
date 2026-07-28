/**
 * Market data DTOs — the shape the server returns, regardless of which
 * upstream provider actually served it. Adding a provider must never change
 * these types; that is the whole point of the adapter layer.
 */

/** Which market an instrument trades on. Drives provider routing server-side. */
export type AssetClass = 'stock' | 'crypto';

/**
 * A normalized instrument identifier.
 *
 * `symbol` is the canonical ticker we use everywhere in the app:
 *   - stocks: the exchange ticker, uppercase — "AAPL", "MSFT"
 *   - crypto: the Binance pair, uppercase — "BTCUSDT", "ETHUSDT"
 */
export interface AssetRef {
  symbol: string;
  assetClass: AssetClass;
}

/** A point-in-time price snapshot. */
export interface Quote extends AssetRef {
  /** Last traded price, in the instrument's quote currency. */
  price: number;
  /** Absolute change over the session / rolling 24h for crypto. */
  change: number;
  /** Percent change, already multiplied by 100 (2.5 means +2.5%). */
  changePercent: number;
  dayHigh: number | null;
  dayLow: number | null;
  dayOpen: number | null;
  previousClose: number | null;
  /** Base-asset volume over the session / rolling 24h. */
  volume: number | null;
  /** Currency the price is denominated in — "USD", "USDT". */
  currency: string;
  /** Epoch ms at which the upstream reported this price. */
  timestamp: number;
}

/** Candlestick intervals we expose. Mapped per-provider server-side. */
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

/** Chart ranges. Server converts these to provider-specific from/to params. */
export type CandleRange = '1d' | '5d' | '1m' | '3m' | '6m' | '1y' | '5y' | 'max';

/** One OHLCV bar. `time` is epoch **seconds** — what lightweight-charts expects. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries extends AssetRef {
  interval: CandleInterval;
  candles: Candle[];
}

/**
 * Company / project fundamentals. Every field past `name` is nullable —
 * free-tier providers have real coverage gaps, and a missing P/E must render
 * as "—" rather than crash a card.
 */
export interface Fundamentals extends AssetRef {
  name: string;
  currency: string;
  marketCap: number | null;
  peRatio: number | null;
  epsTtm: number | null;
  dividendYield: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  description: string | null;
  logoUrl: string | null;
  weekHigh52: number | null;
  weekLow52: number | null;
  /** Circulating supply — crypto only. */
  circulatingSupply: number | null;
}

/** A single dividend event, past or announced-future. */
export interface DividendEvent {
  /** ISO date (YYYY-MM-DD). Own the stock before this date to receive it. */
  exDate: string;
  paymentDate: string | null;
  recordDate: string | null;
  declarationDate: string | null;
  amount: number;
  currency: string;
}

export interface DividendInfo extends AssetRef {
  /** The next announced event, or null if none is scheduled/known. */
  next: DividendEvent | null;
  /** Past events, newest first. */
  history: DividendEvent[];
  /** Sum of the trailing twelve months' payments, per share. */
  trailingAnnualAmount: number | null;
}

export type Sentiment = 'bullish' | 'somewhat-bullish' | 'neutral' | 'somewhat-bearish' | 'bearish';

export interface NewsArticle {
  id: string;
  headline: string;
  summary: string | null;
  url: string;
  source: string;
  imageUrl: string | null;
  /** Epoch ms. */
  publishedAt: number;
  /** Symbols this article was matched to. */
  symbols: string[];
  sentiment: Sentiment | null;
  /** 0–1, provider-supplied where available. */
  relevance: number | null;
}

/** Exchange rates, all expressed as "1 base = N units of key". */
export interface FxRates {
  base: string;
  rates: Record<string, number>;
  /** Epoch ms of the rate snapshot. */
  timestamp: number;
}
