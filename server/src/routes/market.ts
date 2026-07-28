/**
 * Market-data routes.
 *
 * The client talks to these and never learns which upstream served a request —
 * symbol→provider routing lives here, which is what makes swapping a provider
 * a one-file change.
 *
 * Every cacheable response carries X-Cache / X-Data-Age / X-Stale so the UI can
 * render "as of HH:MM" and visibly flag stale data. A cached value must never
 * be indistinguishable from a live one.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AssetClass,
  Quote,
  CandleInterval,
  CandleSeries,
  Fundamentals,
  DividendInfo,
  FxRates,
} from '@aminfinance/shared';
import { CACHE_HEADERS } from '@aminfinance/shared';
import * as psx from '../providers/psx.js';
import * as binance from '../providers/binance.js';
import * as fx from '../providers/fx.js';
import { cached, TTL, type CacheLookup } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';

/**
 * Which provider owns a symbol.
 *
 * Binance pairs are uppercase and end in a known quote asset (BTCUSDT);
 * PSX tickers do not. That heuristic covers every real case here, and an
 * explicit `assetClass` query param overrides it when a caller knows better.
 */
const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB'];

export function classify(symbol: string, hint?: AssetClass): AssetClass {
  if (hint) return hint;
  const s = symbol.toUpperCase();
  return CRYPTO_QUOTE_SUFFIXES.some((q) => s.endsWith(q) && s.length > q.length)
    ? 'crypto'
    : 'stock';
}

function applyCacheHeaders(reply: FastifyReply, meta: CacheLookup<unknown> & { hit: boolean }): void {
  reply.header(CACHE_HEADERS.status, meta.hit ? 'hit' : 'miss');
  reply.header(CACHE_HEADERS.age, String(meta.ageSeconds));
  if (meta.stale) reply.header(CACHE_HEADERS.stale, 'true');
}

const VALID_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/quotes?symbols=FFC,HUBC,BTCUSDT
   *
   * Mixed stock/crypto in one call — the dashboard needs the whole book priced
   * at once, and N round trips would be both slower and quota-hostile.
   * Per-symbol failures are reported inline rather than failing the batch: one
   * delisted ticker must not blank the entire portfolio.
   */
  app.get<{ Querystring: { symbols?: string } }>('/api/quotes', async (request, reply) => {
    const raw = (request.query.symbols ?? '').trim();
    if (!raw) throw AppError.badRequest('Provide ?symbols=AAA,BBB');

    const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) throw AppError.badRequest('No valid symbols supplied.');
    if (symbols.length > 50) throw AppError.badRequest('Too many symbols (max 50).');

    const crypto = symbols.filter((s) => classify(s) === 'crypto');
    const stocks = symbols.filter((s) => classify(s) === 'stock');

    const quotes: Quote[] = [];
    const errors: Record<string, string> = {};
    let oldestAge = 0;
    let anyStale = false;
    let allHit = true;

    // Crypto batches into a single upstream call.
    if (crypto.length > 0) {
      const key = `quotes:crypto:${crypto.join(',')}`;
      try {
        const result = await cached(key, TTL.quote, () => binance.getQuotes(crypto));
        quotes.push(...result.value);
        oldestAge = Math.max(oldestAge, result.ageSeconds);
        anyStale ||= result.stale;
        allHit &&= result.hit;
      } catch (err) {
        for (const s of crypto) errors[s] = err instanceof Error ? err.message : 'failed';
      }
    }

    // PSX is one request per symbol; run them concurrently under the bucket.
    const stockResults = await Promise.allSettled(
      stocks.map((symbol) =>
        cached(`quote:stock:${symbol}`, TTL.quote, () => psx.getQuote(symbol)),
      ),
    );

    stockResults.forEach((result, i) => {
      const symbol = stocks[i] as string;
      if (result.status === 'fulfilled') {
        quotes.push(result.value.value);
        oldestAge = Math.max(oldestAge, result.value.ageSeconds);
        anyStale ||= result.value.stale;
        allHit &&= result.value.hit;
      } else {
        errors[symbol] =
          result.reason instanceof Error ? result.reason.message : 'failed';
      }
    });

    if (quotes.length === 0 && Object.keys(errors).length > 0) {
      throw AppError.providerError('market', `No quotes available. ${Object.values(errors)[0]}`);
    }

    applyCacheHeaders(reply, {
      value: null,
      ageSeconds: oldestAge,
      stale: anyStale,
      hit: allHit && quotes.length > 0,
    });

    return { quotes, ...(Object.keys(errors).length > 0 ? { errors } : {}) };
  });

  /** GET /api/candles/:symbol?interval=1d&limit=400 */
  app.get<{
    Params: { symbol: string };
    Querystring: { interval?: string; limit?: string; assetClass?: AssetClass };
  }>('/api/candles/:symbol', async (request, reply) => {
    const symbol = request.params.symbol.toUpperCase();
    const interval = (request.query.interval ?? '1d') as CandleInterval;
    if (!VALID_INTERVALS.includes(interval)) {
      throw AppError.badRequest(`interval must be one of: ${VALID_INTERVALS.join(', ')}`);
    }
    const limit = Math.min(Number(request.query.limit ?? 400) || 400, 1000);
    const assetClass = classify(symbol, request.query.assetClass);

    const result = await cached<CandleSeries>(
      `candles:${symbol}:${interval}:${limit}`,
      TTL.candles,
      () =>
        assetClass === 'crypto'
          ? binance.getCandles(symbol, interval, limit)
          : psx.getCandles(symbol, interval, limit),
    );

    applyCacheHeaders(reply, result);
    return result.value;
  });

  /** GET /api/fundamentals/:symbol */
  app.get<{ Params: { symbol: string }; Querystring: { assetClass?: AssetClass } }>(
    '/api/fundamentals/:symbol',
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      const assetClass = classify(symbol, request.query.assetClass);

      if (assetClass === 'crypto') {
        // Crypto fundamentals come from the 24h ticker; there is no company
        // profile to fetch. Returning a shaped object keeps the client simple.
        const result = await cached<Fundamentals>(
          `fundamentals:${symbol}`,
          TTL.fundamentals,
          async () => {
            const q = await binance.getQuote(symbol);
            return {
              symbol,
              assetClass: 'crypto' as const,
              name: symbol,
              currency: q.currency,
              marketCap: null,
              peRatio: null,
              epsTtm: null,
              dividendYield: null,
              beta: null,
              sector: 'Cryptocurrency',
              industry: null,
              exchange: 'Binance',
              description: null,
              logoUrl: null,
              weekHigh52: null,
              weekLow52: null,
              circulatingSupply: null,
            };
          },
          { persist: true },
        );
        applyCacheHeaders(reply, result);
        return result.value;
      }

      const result = await cached<Fundamentals>(
        `fundamentals:${symbol}`,
        TTL.fundamentals,
        () => psx.getFundamentals(symbol),
        { persist: true },
      );
      applyCacheHeaders(reply, result);
      return result.value;
    },
  );

  /** GET /api/dividends/:symbol */
  app.get<{ Params: { symbol: string } }>('/api/dividends/:symbol', async (request, reply) => {
    const symbol = request.params.symbol.toUpperCase();
    if (classify(symbol) === 'crypto') {
      const empty: DividendInfo = {
        symbol,
        assetClass: 'crypto',
        next: null,
        history: [],
        trailingAnnualAmount: null,
      };
      return empty;
    }

    const result = await cached<DividendInfo>(
      `dividends:${symbol}`,
      TTL.dividends,
      () => psx.getDividends(symbol),
      { persist: true },
    );
    applyCacheHeaders(reply, result);
    return result.value;
  });

  /** GET /api/fx?base=USD */
  app.get<{ Querystring: { base?: string } }>('/api/fx', async (request, reply) => {
    const base = (request.query.base ?? 'USD').toUpperCase();
    const result = await cached<FxRates>(`fx:${base}`, TTL.fx, () => fx.getRates(base), {
      persist: true,
    });
    applyCacheHeaders(reply, result);
    return result.value;
  });

  /** GET /api/search?q=FF — resolve a ticker before adding a holding. */
  app.get<{ Querystring: { q?: string } }>('/api/search', async (request) => {
    const q = (request.query.q ?? '').trim().toUpperCase();
    if (q.length < 1) throw AppError.badRequest('Provide ?q=SYMBOL');

    const assetClass = classify(q);
    if (assetClass === 'crypto') {
      const pairs = await binance.getTradablePairs();
      const matches = [...pairs].filter((p) => p.startsWith(q)).slice(0, 10);
      return { results: matches.map((symbol) => ({ symbol, assetClass: 'crypto' as const })) };
    }

    const exists = await psx.symbolExists(q);
    return { results: exists ? [{ symbol: q, assetClass: 'stock' as const }] : [] };
  });
}
