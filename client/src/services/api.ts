/**
 * The single RTK Query client.
 *
 * Everything remote goes through our own server, so this is the only place in
 * the app that knows a network exists. The client never learns which upstream
 * (Finnhub, Binance, Alpha Vantage…) served a given response — that routing is
 * the server's business, which is what makes swapping a provider a one-file
 * change. See PROJECT_PLAN.md §4.1.
 */
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query';
import { AUTH_HEADER, CACHE_HEADERS, type ApiError } from '@aminfinance/shared';
import type { HealthResponse } from './types';
import { backendUrl } from './backend';

/**
 * Defaults to the deployed backend. Set VITE_API_URL to override the origin,
 * or leave it blank to use the local Vite proxy.
 */
const baseUrl = backendUrl;

/** Freshness metadata parsed from the server's cache headers. */
export interface CacheMeta {
  hit: boolean;
  ageSeconds: number;
  stale: boolean;
}

const rawBaseQuery = fetchBaseQuery({
  baseUrl,
  prepareHeaders: (headers) => {
    // Gate on our own proxy, not an upstream credential. Absent in the default
    // loopback setup, where the server runs without a secret.
    const secret = import.meta.env.VITE_API_KEY;
    if (secret) headers.set(AUTH_HEADER, secret);
    return headers;
  },
});

/** Freshness metadata rides alongside RTK Query's own request/response meta. */
export type BaseQueryMeta = FetchBaseQueryMeta & { cache: CacheMeta };

function readCacheMeta(headers: Headers | undefined): CacheMeta {
  return {
    hit: headers?.get(CACHE_HEADERS.status) === 'hit',
    ageSeconds: Number(headers?.get(CACHE_HEADERS.age) ?? 0),
    stale: headers?.get(CACHE_HEADERS.stale) === 'true',
  };
}

/**
 * Wraps the base query to (a) normalize every failure into `ApiError` so
 * components branch on a stable `code`, and (b) surface the cache headers as
 * `meta.cache` so the UI can render "as of HH:MM" and flag stale data. Without
 * this, a cached value is indistinguishable from a live one.
 */
const baseQuery: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  Record<string, unknown>,
  BaseQueryMeta
> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions);

  if (result.error) {
    const { status, data } = result.error;

    // Network failure or a non-JSON body — the server is likely down.
    if (status === 'FETCH_ERROR' || status === 'PARSING_ERROR') {
      const fallback: ApiError = {
        error: {
          code: 'internal',
          message: 'Cannot reach the AminFinance server. Please try again shortly.',
        },
      };
      return { error: { status: 503, data: fallback } };
    }

    // Already our envelope — pass through untouched.
    if (data && typeof data === 'object' && 'error' in data) {
      return { error: result.error };
    }

    const fallback: ApiError = {
      error: { code: 'internal', message: 'Unexpected response from server.' },
    };
    return {
      error: { status: typeof status === 'number' ? status : 500, data: fallback },
    };
  }

  // `meta` is absent only when the request never reached the network, which the
  // error branch above has already handled. Attach conditionally anyway — under
  // exactOptionalPropertyTypes an explicit undefined is not an absent key.
  return result.meta
    ? { data: result.data, meta: { ...result.meta, cache: readCacheMeta(result.meta.response?.headers) } }
    : { data: result.data };
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: [
    'Health',
    'Quote',
    'Candles',
    'Fundamentals',
    'Dividends',
    'Fx',
    'News',
    'BinanceAccount',
    'Insight',
    'Economy',
  ],
  // Server-side TTLs already govern real freshness; these control how long an
  // unmounted component's data survives in the client cache.
  keepUnusedDataFor: 300,
  refetchOnFocus: true,
  refetchOnReconnect: true,
  endpoints: (builder) => ({
    getHealth: builder.query<HealthResponse, void>({
      query: () => '/health',
      providesTags: ['Health'],
    }),
  }),
});

export const { useGetHealthQuery } = api;

/** Narrow an RTK Query error into our envelope for display. */
export function toApiError(error: unknown): ApiError['error'] | null {
  if (
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'error' in error.data
  ) {
    return (error.data as ApiError).error;
  }
  return null;
}
