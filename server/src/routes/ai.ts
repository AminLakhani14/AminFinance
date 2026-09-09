/**
 * AI insight routes.
 *
 * Responses are cached for 24h per symbol because these calls are expensive —
 * against a local model that means minutes of wall-clock time, so a user
 * clicking between holdings must not re-generate on every navigation. The
 * cache is bypassable with `refresh: true`, which is why these routes carry a
 * tighter rate limit than the rest of the API.
 */
import type { FastifyInstance } from 'fastify';
import type {
  AnalyzeRequest,
  PortfolioReviewRequest,
  OpportunitiesRequest,
  AssetInsight,
  PortfolioReview,
  OpportunitySet,
  NewsArticle,
} from '@aminfinance/shared';
import { CACHE_HEADERS } from '@aminfinance/shared';
import * as ai from '../providers/ai.js';
import * as psx from '../providers/psx.js';
import * as binance from '../providers/binance.js';
import * as metals from '../providers/metals.js';
import { cached, get as cacheGet, set as cacheSet, TTL } from '../lib/cache.js';
import { computeTechnicals } from '../lib/indicators.js';

/**
 * Reduce a series to at most `max` points, keeping the first and last.
 *
 * Even-stride sampling rather than averaging: the chart is a shape, and
 * averaging would smooth away the swing highs and lows the levels are drawn
 * against, making the annotation lines look wrong against their own chart.
 */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)] as number);
}
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';
import { classify } from './market.js';

function requireConfigured(): void {
  if (!config.providers.ai) {
    throw AppError.notConfigured('AI', 'OPENAI_BASE_URL + OPENAI_MODEL');
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // AI calls monopolise the model host for minutes — a much tighter budget
  // than the global limiter.
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
      // Only PSX issuers have fundamentals or announcements to fetch; crypto
      // and spot metal have neither, so the model is told so explicitly rather
      // than being handed empty objects that read as missing data.
      const isEquity = assetClass === 'stock';
      const [quote, fundamentals, headlines, candles] = await Promise.all([
        assetClass === 'crypto'
          ? binance.getQuote(symbol)
          : assetClass === 'commodity'
            ? metals.getQuote(symbol)
            : psx.getQuote(symbol),
        isEquity ? psx.getFundamentals(symbol).catch(() => null) : Promise.resolve(null),
        isEquity
          ? psx
              .getAnnouncements(symbol)
              .then((a) => a.slice(0, 8).map((x) => ({ headline: x.title }) as { headline: string }))
              .catch(() => [])
          : Promise.resolve<NewsArticle[]>([]),
        // 260 daily bars: enough for a 200-period average plus a 52-week range.
        // Shares the candle cache with the chart, so opening an asset page and
        // then asking for an insight is one upstream fetch, not two. A failure
        // here degrades to an insight without technicals rather than no
        // insight at all.
        cached(
          `candles:${symbol}:1d:260`,
          TTL.candles,
          () =>
            assetClass === 'crypto'
              ? binance.getCandles(symbol, '1d', 260)
              : assetClass === 'commodity'
                ? metals.getCandles(symbol, '1d', 260)
                : psx.getCandles(symbol, '1d', 260),
        )
          .then((r) => r.value.candles)
          .catch(() => []),
      ]);

      const technicals = candles.length > 0 ? computeTechnicals(candles) : null;

      const pnlPercent =
        position && position.averageCost > 0
          ? ((quote.price - position.averageCost) / position.averageCost) * 100
          : null;

      const insight = await ai.analyzeAsset({
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
        technicals,
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

        const review = await ai.reviewPortfolio({
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

    /**
     * POST /api/ai/opportunities
     *
     * Ranks the whole book — plus any extra candidates — in one model call.
     * Everything the ranking needs (quote, candles, indicators) is gathered per
     * symbol first; a symbol that cannot be priced is reported in `skipped`
     * rather than dropped, so an unconfigured provider is visible instead of
     * silently shrinking the list.
     */
    scoped.post<{ Body: OpportunitiesRequest }>(
      '/api/ai/opportunities',
      async (request, reply) => {
        requireConfigured();
        const { holdings, candidates, currency, refresh } = request.body ?? {};
        if (!Array.isArray(holdings) || holdings.length === 0) {
          throw AppError.badRequest('holdings must be a non-empty array');
        }

        const extra = [...new Set((candidates ?? []).map((s) => s.trim().toUpperCase()))].filter(
          (s) => s && !holdings.some((h) => h.symbol.toUpperCase() === s),
        );

        const fingerprint = [
          ...holdings.map((h) => `${h.symbol}:${h.quantity}:${h.averageCost}`).sort(),
          ...extra.map((s) => `+${s}`).sort(),
        ].join('|');
        const key = `ai:opportunities:${currency}:${fingerprint}`;

        if (!refresh) {
          const hit = cacheGet<OpportunitySet>(key);
          if (hit) {
            reply.header(CACHE_HEADERS.status, 'hit');
            reply.header(CACHE_HEADERS.age, String(hit.ageSeconds));
            return hit.value;
          }
        }

        const wanted = [
          ...holdings.map((h) => ({ symbol: h.symbol.toUpperCase(), holding: h })),
          ...extra.map((symbol) => ({ symbol, holding: undefined })),
        ];

        const skipped: OpportunitySet['skipped'] = [];
        const settled = await Promise.allSettled(
          wanted.map(async ({ symbol, holding }) => {
            const assetClass = classify(symbol, holding?.assetClass);
            const quote = await (assetClass === 'crypto'
              ? binance.getQuote(symbol)
              : assetClass === 'commodity'
                ? metals.getQuote(symbol)
                : psx.getQuote(symbol));

            // Indicators are best-effort: a ranking without a chart is thinner
            // but still useful, whereas no quote means no comparison at all.
            const candles = await cached(`candles:${symbol}:1d:260`, TTL.candles, () =>
              assetClass === 'crypto'
                ? binance.getCandles(symbol, '1d', 260)
                : assetClass === 'commodity'
                  ? metals.getCandles(symbol, '1d', 260)
                  : psx.getCandles(symbol, '1d', 260),
            )
              .then((r) => r.value.candles)
              .catch(() => []);

            // Only PSX issuers have accounts to fetch, and a missing profile
            // must not sink the whole asset — it ranks on price and trend.
            const fundamentals =
              assetClass === 'stock'
                ? await psx.getFundamentals(symbol).catch(() => null)
                : null;

            const pnlPercent =
              holding && holding.averageCost > 0
                ? ((quote.price - holding.averageCost) / holding.averageCost) * 100
                : null;

            return {
              symbol,
              assetClass,
              price: quote.price,
              currency: quote.currency,
              changePercent: quote.changePercent,
              held: Boolean(holding),
              quantity: holding?.quantity ?? null,
              averageCost: holding?.averageCost ?? null,
              pnlPercent,
              allocationPercent: holding?.allocationPercent ?? null,
              technicals: candles.length > 0 ? computeTechnicals(candles) : null,
              fundamentals: fundamentals
                ? {
                    name: fundamentals.name,
                    marketCap: fundamentals.marketCap,
                    peRatio: fundamentals.peRatio,
                    epsTtm: fundamentals.epsTtm,
                    dividendYield: fundamentals.dividendYield,
                    sector: fundamentals.sector,
                  }
                : null,
              // ~90 points is all a row-sized chart can resolve; sending 260
              // would trible the payload for pixels nobody can see.
              series: downsample(
                candles.map((c) => c.close),
                90,
              ),
            };
          }),
        );

        const assets = settled.flatMap((result, i) => {
          if (result.status === 'fulfilled') return [result.value];
          const symbol = wanted[i]?.symbol ?? 'unknown';
          skipped.push({
            symbol,
            reason: result.reason instanceof Error ? result.reason.message : 'could not be priced',
          });
          return [];
        });

        if (assets.length === 0) {
          throw AppError.providerError(
            'AI',
            `None of the ${wanted.length} symbols could be priced, so there is nothing to rank.`,
          );
        }

        const ranked = await ai.rankOpportunities({ assets, currency: currency || 'PKR' });
        const result: OpportunitySet = { ...ranked, skipped };

        cacheSet(key, result, TTL.aiInsight, true);
        reply.header(CACHE_HEADERS.status, 'miss');
        return result;
      },
    );
  });
}
