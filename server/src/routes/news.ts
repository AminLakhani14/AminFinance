/**
 * News.
 *
 * PSX company announcements are the only PSX-native source — there is no free
 * PSX news API. They are genuine corporate disclosures (results, board
 * meetings, corporate actions), which is arguably more decision-relevant than
 * commentary anyway.
 *
 * Crypto has no configured news provider, so those symbols return nothing
 * rather than a fabricated feed.
 */
import type { FastifyInstance } from 'fastify';
import type { NewsArticle, Sentiment } from '@aminfinance/shared';
import { CACHE_HEADERS } from '@aminfinance/shared';
import * as psx from '../providers/psx.js';
import { cached, TTL } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { classify } from './market.js';

/**
 * Crude keyword sentiment over announcement titles.
 *
 * Deliberately conservative: most disclosures are procedural and should read
 * as neutral. This is a hint for scanning a list, not an analytical claim, and
 * the UI labels it as such.
 */
const POSITIVE = /\b(profit|dividend|bonus|growth|increase|expansion|record|award|acquisition)\b/i;
const NEGATIVE = /\b(loss|decline|default|penalty|suspension|resignation|litigation|delist)\b/i;

function guessSentiment(title: string): Sentiment | null {
  const positive = POSITIVE.test(title);
  const negative = NEGATIVE.test(title);
  if (positive && !negative) return 'somewhat-bullish';
  if (negative && !positive) return 'somewhat-bearish';
  return null;
}

/** "Apr 30, 2026" → epoch ms. Returns now when unparseable. */
function parseDate(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function newsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/news?symbols=FFC,HUBC */
  app.get<{ Querystring: { symbols?: string } }>('/api/news', async (request, reply) => {
    const raw = (request.query.symbols ?? '').trim();
    if (!raw) throw AppError.badRequest('Provide ?symbols=AAA,BBB');

    const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 20);
    const stocks = symbols.filter((s) => classify(s) === 'stock');

    const results = await Promise.allSettled(
      stocks.map((symbol) =>
        cached(`news:${symbol}`, TTL.news, async () => {
          const announcements = await psx.getAnnouncements(symbol);
          return announcements.map((a, index): NewsArticle => ({
            // Stable id, including the index: PSX genuinely files multiple
            // announcements with the same date *and* the same title (e.g.
            // several directors' interest disclosures on one day), so date +
            // title alone collides and React drops rows as duplicate keys.
            id: `psx-${symbol}-${a.category}-${a.date}-${index}`,
            headline: a.title,
            summary: null,
            url: `https://dps.psx.com.pk/company/${symbol}`,
            source: `PSX · ${a.category}`,
            imageUrl: null,
            publishedAt: parseDate(a.date),
            symbols: [symbol],
            sentiment: guessSentiment(a.title),
            relevance: 1,
          }));
        }),
      ),
    );

    const articles: NewsArticle[] = [];
    let oldestAge = 0;
    let allHit = true;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        articles.push(...result.value.value);
        oldestAge = Math.max(oldestAge, result.value.ageSeconds);
        allHit &&= result.value.hit;
      }
    }

    articles.sort((a, b) => b.publishedAt - a.publishedAt);

    reply.header(CACHE_HEADERS.status, allHit && articles.length > 0 ? 'hit' : 'miss');
    reply.header(CACHE_HEADERS.age, String(oldestAge));

    return {
      articles: articles.slice(0, 100),
      // Be explicit that crypto coverage is absent rather than empty-by-accident.
      coverage: {
        stock: stocks.length > 0,
        crypto: false,
        note: 'PSX announcements only. No free crypto news provider is configured.',
      },
    };
  });
}
