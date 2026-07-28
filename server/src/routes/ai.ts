/**
 * AI insight routes.
 *
 * Responses are cached for 24h per symbol because these calls cost real money —
 * a user clicking between holdings must not re-bill on every navigation. The
 * cache is bypassable with `refresh: true`, which is why these routes carry a
 * tighter rate limit than the rest of the API.
 */
import type { FastifyInstance } from 'fastify';
import type {
  AnalyzeRequest,
  PortfolioReviewRequest,
  AssetInsight,
  PortfolioReview,
  NewsArticle,
} from '@aminfinance/shared';
import { CACHE_HEADERS } from '@aminfinance/shared';
import * as claude from '../providers/claude.js';
import * as psx from '../providers/psx.js';
import * as binance from '../providers/binance.js';
import { cached, get as cacheGet, set as cacheSet, TTL } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';
import { classify } from './market.js';

function requireConfigured(): void {
  if (!config.providers.anthropic) {
    throw AppError.notConfigured('Claude', 'ANTHROPIC_API_KEY');
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // AI calls cost money — a much tighter budget than the global limiter.
  await app.register(async (scoped) => {
    await scoped.register(import('@fastify/rate-limit'), {
      max: 20,
      timeWindow: '1 hour',
      keyGenerator: (req) => req.ip,
    });

    /** POST /api/ai/analyze */
    scoped.post<{ Body: AnalyzeRequest }>('/api/ai/analyze', async (request, reply) => {
      requireConfigured();
      const { symbol: rawSymbol, position, refresh } = request.body ?? {};
      if (!rawSymbol) throw AppError.badRequest('symbol is required');

      const symbol = rawSymbol.toUpperCase();
      const assetClass = request.body.assetClass ?? classify(symbol);
      // Position is part of the cache key: the same asset warrants different
      // analysis for a holder sitting on a loss than for a fresh entry.
      const key = `ai:asset:${symbol}:${position ? `${position.quantity}@${position.averageCost}` : 'none'}`;

      if (!refresh) {
        const hit = cacheGet<AssetInsight>(key);
        if (hit) {
          reply.header(CACHE_HEADERS.status, 'hit');
          reply.header(CACHE_HEADERS.age, String(hit.ageSeconds));
          return hit.value;
        }
      }

      // Assemble the factual snapshot the model reasons over. Gathered here so
      // the prompt is grounded in the same data the UI is showing.
      const [quote, fundamentals, headlines] = await Promise.all([
        assetClass === 'crypto' ? binance.getQuote(symbol) : psx.getQuote(symbol),
        assetClass === 'crypto'
          ? Promise.resolve(null)
          : psx.getFundamentals(symbol).catch(() => null),
        assetClass === 'crypto'
          ? Promise.resolve<NewsArticle[]>([])
          : psx
              .getAnnouncements(symbol)
              .then((a) => a.slice(0, 8).map((x) => ({ headline: x.title }) as { headline: string }))
              .catch(() => []),
      ]);

      const pnlPercent =
        position && position.averageCost > 0
          ? ((quote.price - position.averageCost) / position.averageCost) * 100
          : null;

      const insight = await claude.analyzeAsset({
        symbol,
        assetClass,
        name: fundamentals?.name ?? symbol,
        price: quote.price,
        currency: quote.currency,
        changePercent: quote.changePercent,
        marketCap: fundamentals?.marketCap ?? null,
        peRatio: fundamentals?.peRatio ?? null,
        dividendYield: fundamentals?.dividendYield ?? null,
        userCostBasis: position?.averageCost ?? null,
        userQuantity: position?.quantity ?? null,
        userPnlPercent: pnlPercent,
        headlines: headlines.map((h) => h.headline),
        asOf: quote.timestamp,
      });

      cacheSet(key, insight, TTL.aiInsight, true);
      reply.header(CACHE_HEADERS.status, 'miss');
      return insight;
    });

    /** POST /api/ai/portfolio-review */
    scoped.post<{ Body: PortfolioReviewRequest }>(
      '/api/ai/portfolio-review',
      async (request, reply) => {
        requireConfigured();
        const { holdings, currency, refresh } = request.body ?? {};
        if (!Array.isArray(holdings) || holdings.length === 0) {
          throw AppError.badRequest('holdings must be a non-empty array');
        }

        // Key on composition so a review is reused until the book changes.
        const fingerprint = holdings
          .map((h) => `${h.symbol}:${h.quantity}:${h.averageCost}`)
          .sort()
          .join('|');
        const key = `ai:portfolio:${currency}:${fingerprint}`;

        if (!refresh) {
          const hit = cacheGet<PortfolioReview>(key);
          if (hit) {
            reply.header(CACHE_HEADERS.status, 'hit');
            reply.header(CACHE_HEADERS.age, String(hit.ageSeconds));
            return hit.value;
          }
        }

        const totalValue = holdings.reduce((sum, h) => sum + h.quantity * h.averageCost, 0);

        const review = await claude.reviewPortfolio({
          holdings: holdings.map((h) => ({
            symbol: h.symbol,
            assetClass: h.assetClass,
            quantity: h.quantity,
            averageCost: h.averageCost,
            allocationPercent: h.allocationPercent,
          })),
          currency: currency || 'PKR',
          totalValue,
        });

        cacheSet(key, review, TTL.aiInsight, true);
        reply.header(CACHE_HEADERS.status, 'miss');
        return review;
      },
    );
  });
}
