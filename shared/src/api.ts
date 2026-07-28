/**
 * Transport-level contract: error envelope, cache metadata headers, and the
 * live price stream protocol.
 */

/**
 * Every non-2xx response from the server has this body. Fastify's default
 * error shape is overridden in `server/src/index.ts` so this holds everywhere.
 */
export interface ApiError {
  error: {
    /** Stable machine-readable code — switch on this, never on `message`. */
    code: ApiErrorCode;
    /** Human-readable, safe to surface in the UI. */
    message: string;
    /** Which upstream failed, when the failure came from one. */
    provider?: string;
    /** Seconds to wait before retrying — set on `rate_limited`. */
    retryAfter?: number;
  };
}

export type ApiErrorCode =
  /** Malformed request — bad symbol, missing param, failed schema validation. */
  | 'bad_request'
  /** Missing or wrong shared-secret header. See PROJECT_PLAN.md §4.4. */
  | 'unauthorized'
  /** Symbol or resource not known to any configured provider. */
  | 'not_found'
  /** Our own token bucket, or an upstream 429, is holding the request off. */
  | 'rate_limited'
  /** The upstream API key for this route is not set in server/.env. */
  | 'provider_not_configured'
  /** Upstream returned an error or unparseable payload. */
  | 'provider_error'
  /** Upstream did not respond in time. */
  | 'upstream_timeout'
  /** Unexpected server-side failure. */
  | 'internal';

/**
 * Response headers the server sets on cacheable routes. The UI reads these to
 * render "as of HH:MM" and to flag stale data, so a cached value is never
 * mistaken for a live one.
 */
export const CACHE_HEADERS = {
  /** "hit" | "miss" */
  status: 'x-cache',
  /** Age of the served payload, in seconds. */
  age: 'x-data-age',
  /** "true" when served past its TTL because the rate limiter was exhausted. */
  stale: 'x-stale',
} as const;

/** Header carrying the shared secret on every `/api/*` request. */
export const AUTH_HEADER = 'x-aminfinance-key';

/** A payload plus its freshness metadata, as the client's baseQuery unwraps it. */
export interface CachedPayload<T> {
  data: T;
  cache: {
    hit: boolean;
    /** Seconds since the payload was fetched upstream. */
    ageSeconds: number;
    stale: boolean;
  };
}

// ---------------------------------------------------------------------------
// Live price stream (WS /ws/prices)
// ---------------------------------------------------------------------------

/** Client → server. Replaces the full subscription set, not a delta. */
export interface PriceSubscribeMessage {
  type: 'subscribe';
  /** Binance pairs, e.g. ["BTCUSDT", "ETHUSDT"]. Empty array unsubscribes all. */
  symbols: string[];
}

/** Server → client. One message per tick, batched by symbol. */
export interface PriceTickMessage {
  type: 'tick';
  symbol: string;
  price: number;
  changePercent: number;
  timestamp: number;
}

/** Server → client. Sent when the upstream socket drops or recovers. */
export interface PriceStatusMessage {
  type: 'status';
  connected: boolean;
  message?: string;
}

export type PriceStreamClientMessage = PriceSubscribeMessage;
export type PriceStreamServerMessage = PriceTickMessage | PriceStatusMessage;
