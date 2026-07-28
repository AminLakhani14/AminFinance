/**
 * Binance account DTOs — served by the signed proxy routes.
 *
 * These come from endpoints the browser cannot reach (CORS-blocked preflight
 * on `X-MBX-APIKEY`), which is the primary reason the server exists.
 * See PROJECT_PLAN.md §1.1.
 */

/** One asset balance in the spot wallet. */
export interface BinanceBalance {
  /** Base asset, e.g. "BTC", "ETH", "USDT". */
  asset: string;
  free: number;
  locked: number;
  /** `free + locked`. */
  total: number;
}

export interface BinanceAccount {
  balances: BinanceBalance[];
  canTrade: boolean;
  canWithdraw: boolean;
  /** Epoch ms the account snapshot was taken upstream. */
  updateTime: number;
}

/**
 * A single executed trade (fill). Maps to a `Transaction` client-side —
 * `externalId` is set from `id` so re-syncing never duplicates rows.
 */
export interface BinanceTrade {
  id: string;
  orderId: string;
  /** Trading pair, e.g. "BTCUSDT". */
  symbol: string;
  price: number;
  quantity: number;
  /** `price * quantity`, in the quote asset. */
  quoteQuantity: number;
  commission: number;
  commissionAsset: string;
  /** True when this side of the trade was the buy. */
  isBuyer: boolean;
  /** Epoch ms of execution. */
  time: number;
}
