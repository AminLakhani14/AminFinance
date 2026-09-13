/**
 * All server endpoints, injected into the single RTK Query client.
 *
 * Kept separate from `api.ts` so the base-query plumbing (error normalization,
 * cache-header parsing) stays readable next to the endpoint list.
 */
import type {
  Quote,
  CandleSeries,
  CandleInterval,
  Fundamentals,
  DividendInfo,
  FxRates,
  NewsArticle,
  Transaction,
  AssetInsight,
  PortfolioReview,
  AnalyzeRequest,
  PortfolioReviewRequest,
  OpportunitySet,
  OpportunitiesRequest,
  MarketListing,
  AssetClass,
} from '@aminfinance/shared';
import { api } from './api';

export interface QuotesResponse {
  quotes: Quote[];
  /** Per-symbol failures. One bad ticker must not blank the whole portfolio. */
  errors?: Record<string, string>;
}

export interface BinancePosition {
  asset: string;
  free: number;
  locked: number;
  total: number;
  pair: string | null;
  price: number | null;
  valueUsdt: number | null;
  /** Wrapped/staked tickers folded into this asset, e.g. ["WBETH"] under ETH. */
  wrappedFrom?: string[];
}

export interface BinanceBalancesResponse {
  positions: BinancePosition[];
  totalUsdt: number;
  canTrade: boolean;
  canWithdraw: boolean;
  updateTime: number;
}

export interface NewsResponse {
  articles: NewsArticle[];
  coverage: { stock: boolean; crypto: boolean; note: string };
}

export interface SearchResponse {
  results: Array<{ symbol: string; assetClass: AssetClass }>;
}

export const marketApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getQuotes: builder.query<QuotesResponse, string[]>({
      query: (symbols) => `/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`,
      providesTags: ['Quote'],
    }),

    getCandles: builder.query<
      CandleSeries,
      { symbol: string; interval?: CandleInterval; limit?: number }
    >({
      query: ({ symbol, interval = '1d', limit = 400 }) =>
        `/api/candles/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}`,
      providesTags: (_r, _e, arg) => [{ type: 'Candles' as const, id: arg.symbol }],
    }),

    getFundamentals: builder.query<Fundamentals, string>({
      query: (symbol) => `/api/fundamentals/${encodeURIComponent(symbol)}`,
      providesTags: (_r, _e, symbol) => [{ type: 'Fundamentals' as const, id: symbol }],
    }),

    getDividends: builder.query<DividendInfo, string>({
      query: (symbol) => `/api/dividends/${encodeURIComponent(symbol)}`,
      providesTags: (_r, _e, symbol) => [{ type: 'Dividends' as const, id: symbol }],
    }),

    getFx: builder.query<FxRates, string | void>({
      query: (base) => `/api/fx?base=${base ?? 'USD'}`,
      providesTags: ['Fx'],
    }),

    getNews: builder.query<NewsResponse, string[]>({
      query: (symbols) => `/api/news?symbols=${encodeURIComponent(symbols.join(','))}`,
      providesTags: ['News'],
    }),

    searchSymbol: builder.query<SearchResponse, string>({
      query: (q) => `/api/search?q=${encodeURIComponent(q)}`,
    }),

    /**
     * Issuer logo URLs, batched.
     *
     * PSX's bulk listing carries no issuer websites, so logos are looked up
     * separately for the rows on screen. A symbol with no logo maps to null,
     * which the caller caches so it is never asked about twice.
     */
    getLogos: builder.query<{ logos: Record<string, string | null> }, string[]>({
      query: (symbols) => `/api/logos?symbols=${encodeURIComponent(symbols.join(','))}`,
    }),

    getBinanceBalances: builder.query<BinanceBalancesResponse, void>({
      query: () => '/api/binance/balances',
      providesTags: ['BinanceAccount'],
    }),

    getBinanceTrades: builder.query<{ transactions: Transaction[]; errors?: Record<string, string> }, string[]>({
      query: (symbols) => `/api/binance/trades?symbols=${encodeURIComponent(symbols.join(','))}`,
    }),

    analyzeAsset: builder.mutation<AssetInsight, AnalyzeRequest>({
      query: (body) => ({ url: '/api/ai/analyze', method: 'POST', body }),
      invalidatesTags: (_r, _e, arg) => [{ type: 'Insight' as const, id: arg.symbol }],
    }),

    reviewPortfolio: builder.mutation<PortfolioReview, PortfolioReviewRequest>({
      query: (body) => ({ url: '/api/ai/portfolio-review', method: 'POST', body }),
    }),

    getMarketListing: builder.query<MarketListing, { assetClass: AssetClass; quote?: string }>({
      query: ({ assetClass, quote }) =>
        `/api/market/${assetClass}${quote ? `?quote=${encodeURIComponent(quote)}` : ''}`,
    }),

    rankOpportunities: builder.mutation<OpportunitySet, OpportunitiesRequest>({
      query: (body) => ({ url: '/api/ai/opportunities', method: 'POST', body }),
    }),
  }),
});

export const {
  useGetQuotesQuery,
  useGetCandlesQuery,
  useGetFundamentalsQuery,
  useGetDividendsQuery,
  useGetFxQuery,
  useGetNewsQuery,
  useLazySearchSymbolQuery,
  useLazyGetLogosQuery,
  useGetBinanceBalancesQuery,
  useLazyGetBinanceTradesQuery,
  useAnalyzeAssetMutation,
  useReviewPortfolioMutation,
  useGetMarketListingQuery,
  useRankOpportunitiesMutation,
} = marketApi;
