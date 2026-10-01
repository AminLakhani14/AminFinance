/**
 * The trading desk: buy, sell and stop levels from the live market.
 *
 * Two scopes, one route:
 *
 *  - `holdings` plans every position the investor already owns — add, hold,
 *    take profit or sell, at which prices, and for how long.
 *  - `market` screens the most-traded PSX equities and Binance USDT pairs on
 *    their daily charts (`lib/screen.ts`) and plans the best few setups among
 *    names the investor does not own.
 *
 * Every response is fast. Plans come from the chart engine (`lib/tradeRules.ts`)
 * the moment prices and candles are in hand — milliseconds from cache, a
 * second or two cold — and the AI's review of each plan runs in the background
 * (`providers/aiTrading.ts`). A response carries whatever reviews have landed
 * plus `aiPending`; the client polls until that reaches zero. Polling is cheap
 * by design: the inputs are cached, the engine is pure arithmetic, and a
 * review in flight is never started twice.
 */
import type { FastifyInstance } from 'fastify';
import type {
  AssetClass,
  Candle,
  CandleSeries,
  MarketListing,
  MarketPulse,
  MarketRow,
  Quote,
  TradePlan,
  TradeSeriesPoint,
  TradingDesk,
  TradingRequest,
} from '@aminfinance/shared';
import * as psx from '../providers/psx.js';
import * as binance from '../providers/binance.js';
import * as metals from '../providers/metals.js';
import * as tradingview from '../providers/tradingview.js';
import { finalisePlan, reviewState } from '../providers/aiTrading.js';
import { planByRules, type TradeInput } from '../lib/tradeRules.js';
import {
  cached,
  get as cacheGet,
  getStale,
  set as cacheSet,
  REVALIDATE,
  TTL,
} from '../lib/cache.js';
import { computeTechnicals } from '../lib/indicators.js';
import {
  breadth,
  chartTags,
  liquidCoins,
  liquidStocks,
  mapPool,
  setupScore,
} from '../lib/screen.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';
import { classify } from './market.js';

/** Most-traded names screened per class. */
const UNIVERSE = { stock: 30, crypto: 30 } as const;
/** Best setups per class that get a full plan. */
const SHORTLIST = 5;
/** A held book larger than this is planned in part, with the rest reported. */
const MAX_HOLDINGS = 30;
/** Enough points for a card-width chart to show its swings. */
const SERIES_POINTS = 120;
/** Concurrent Binance and metals candle fetches — inside Binance's 20-request burst. PSX goes over one socket. */
const POOL = 10;

/** Ranked so the actionable setups lead the scan. */
const SIGNAL_ORDER: Record<TradePlan['signal'], number> = {
  'buy-now': 0,
  'buy-on-dip': 1,
  add: 2,
  'take-profit': 3,
  sell: 4,
  hold: 5,
  avoid: 6,
};
const CONFIDENCE_ORDER = { high: 0, moderate: 1, low: 2 } as const;

type Item = { symbol: string; assetClass: AssetClass };

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : 'could not be priced';
}

// ---------------------------------------------------------------------------
// Inputs, cache-first
// ---------------------------------------------------------------------------

/** Same key and shape as the chart and AI routes, so every route shares one fetch. */
const candleKey = (symbol: string): string => `candles:${symbol}:1d:260`;

async function candlesFor(symbol: string, assetClass: AssetClass): Promise<Candle[]> {
  const result = await cached<CandleSeries>(
    candleKey(symbol),
    TTL.candles,
    () =>
      assetClass === 'crypto'
        ? binance.getCandles(symbol, '1d', 260)
        : assetClass === 'commodity'
          ? metals.getCandles(symbol, '1d', 260)
          : psx.getCandles(symbol, '1d', 260),
    { revalidateWithinMs: REVALIDATE.candles },
  );
  return result.value.candles;
}

/** PSX histories over one connection, each cached as it lands. */
async function fetchPsxCandles(symbols: string[]): Promise<Map<string, Candle[] | Error>> {
  const batch = await psx.getCandlesBatch(symbols, '1d', 260);
  for (const symbol of symbols) {
    const result = batch.get(symbol);
    if (Array.isArray(result)) {
      const series: CandleSeries = { symbol, assetClass: 'stock', interval: '1d', candles: result };
      cacheSet(candleKey(symbol), series, TTL.candles);
    }
  }
  return batch;
}

/** PSX symbols with a background refresh already in flight. */
const psxRefreshing = new Set<string>();

/**
 * Daily candles for many symbols.
 *
 * Fresh cache first. A PSX series that expired recently is served as it is
 * and the whole set refreshed in one background batch, so a request never
 * waits on a chart it had a moment ago. Only PSX symbols never seen, or too
 * old to trust, are fetched inline — together, over a single connection — and
 * one whose fetch fails falls back to its last good series rather than
 * vanishing. Coins and metals go a few at a time through the same rules.
 */
async function dailyCandles(items: Item[]): Promise<Map<string, Candle[] | Error>> {
  const out = new Map<string, Candle[] | Error>();
  const psxMissing: string[] = [];
  const psxExpired: string[] = [];
  const others: Item[] = [];

  for (const item of items) {
    const key = candleKey(item.symbol);
    const hit = cacheGet<CandleSeries>(key);
    if (hit) {
      out.set(item.symbol, hit.value.candles);
      continue;
    }
    if (item.assetClass !== 'stock') {
      others.push(item);
      continue;
    }
    const recent = getStale<CandleSeries>(key);
    if (recent && recent.ageSeconds * 1000 <= TTL.candles + REVALIDATE.candles) {
      out.set(item.symbol, recent.value.candles);
      psxExpired.push(item.symbol);
    } else {
      psxMissing.push(item.symbol);
    }
  }

  const toRefresh = psxExpired.filter((s) => !psxRefreshing.has(s));
  if (toRefresh.length > 0) {
    for (const s of toRefresh) psxRefreshing.add(s);
    fetchPsxCandles(toRefresh)
      .catch(() => undefined)
      .finally(() => {
        for (const s of toRefresh) psxRefreshing.delete(s);
      });
  }

  await Promise.all([
    psxMissing.length > 0
      ? fetchPsxCandles(psxMissing)
          .then((batch) => {
            for (const symbol of psxMissing) {
              const result = batch.get(symbol) ?? new Error('No history returned.');
              const stale = result instanceof Error ? getStale<CandleSeries>(candleKey(symbol)) : null;
              out.set(symbol, stale ? stale.value.candles : result);
            }
          })
          .catch((err: unknown) => {
            for (const symbol of psxMissing) out.set(symbol, toError(err));
          })
      : null,
    mapPool(others, POOL, async (item) => {
      try {
        out.set(item.symbol, await candlesFor(item.symbol, item.assetClass));
      } catch (err) {
        out.set(item.symbol, toError(err));
      }
    }),
  ]);
  return out;
}

/** Latest prices: PSX in one scanner call, coins in one Binance call, metals each. */
async function quotesFor(items: Item[]): Promise<Map<string, Quote | Error>> {
  const out = new Map<string, Quote | Error>();
  const of = (cls: AssetClass) => items.filter((i) => i.assetClass === cls).map((i) => i.symbol).sort();
  const stocks = of('stock');
  const coins = of('crypto');
  const fail = (symbols: string[], err: unknown) => {
    for (const s of symbols) out.set(s, toError(err));
  };

  await Promise.all([
    stocks.length > 0
      ? cached(`quotes:stock:${stocks.join(',')}`, TTL.quote, () => psx.getQuotes(stocks), {
          revalidateWithinMs: REVALIDATE.quote,
        })
          .then((r) => {
            for (const q of r.value.quotes) out.set(q.symbol, q);
            for (const s of r.value.missing) out.set(s, AppError.notFound(`No PSX quote for "${s}".`));
          })
          .catch((err: unknown) => fail(stocks, err))
      : null,
    coins.length > 0
      ? cached(`quotes:crypto:${coins.join(',')}`, TTL.quote, () => binance.getQuotes(coins), {
          revalidateWithinMs: REVALIDATE.quote,
        })
          .then((r) => {
            for (const q of r.value) out.set(q.symbol, q);
          })
          .catch((err: unknown) => fail(coins, err))
      : null,
    ...of('commodity').map((s) =>
      cached(`quote:commodity:${s}`, TTL.quote, () => metals.getQuote(s), {
        revalidateWithinMs: REVALIDATE.quote,
      })
        .then((r) => void out.set(s, r.value))
        .catch((err: unknown) => fail([s], err)),
    ),
  ]);
  return out;
}

/** Fetch and cache issuer profiles. Best-effort: a plan without them is thinner, never absent. */
async function fetchProfiles(symbols: string[]): Promise<Record<string, tradingview.IssuerProfile>> {
  const fetched = await tradingview.getProfiles(symbols).catch(() => ({}));
  for (const [s, profile] of Object.entries(fetched)) cacheSet(`profile:${s}`, profile, TTL.fundamentals, true);
  return fetched;
}

/**
 * Issuer facts for PSX symbols, cached per symbol for a day. Expired ones
 * within the revalidate window are served and refreshed in the background;
 * the rest are fetched together in one call.
 */
async function profilesFor(stocks: string[]): Promise<Record<string, tradingview.IssuerProfile>> {
  const out: Record<string, tradingview.IssuerProfile> = {};
  const missing: string[] = [];
  const expired: string[] = [];
  for (const s of stocks) {
    const hit = cacheGet<tradingview.IssuerProfile>(`profile:${s}`);
    const recent = hit ? null : getStale<tradingview.IssuerProfile>(`profile:${s}`);
    if (hit) out[s] = hit.value;
    else if (recent && recent.ageSeconds * 1000 <= TTL.fundamentals + REVALIDATE.fundamentals) {
      out[s] = recent.value;
      expired.push(s);
    } else missing.push(s);
  }
  if (expired.length > 0) void fetchProfiles(expired);
  if (missing.length > 0) Object.assign(out, await fetchProfiles(missing));
  return out;
}

/**
 * A market listing, sharing the market page's cache entry and shape.
 *
 * `stale` is passed through because the cache serves the last good listing
 * when the upstream fails, and that copy can be days old: its liquidity
 * ranking is still a fair guide to what trades, its prices are not today's.
 */
async function listing(assetClass: 'stock' | 'crypto'): Promise<{ rows: MarketRow[]; stale: boolean }> {
  const result =
    assetClass === 'stock'
      ? await cached<MarketListing>(
          'market:stock',
          TTL.quote,
          async () => ({ assetClass: 'stock' as const, rows: await psx.getMarketWatch(), asOf: Date.now() }),
          { persist: true, revalidateWithinMs: REVALIDATE.listing },
        )
      : await cached<MarketListing>(
          'market:crypto:USDT',
          TTL.quote,
          async () => ({
            assetClass: 'crypto' as const,
            rows: await binance.getMarketTickers('USDT'),
            asOf: Date.now(),
          }),
          { persist: true, revalidateWithinMs: REVALIDATE.listing },
        );
  return { rows: result.value.rows, stale: result.stale };
}

/**
 * Closes for the card's chart, at most `max` of them, keeping first and last.
 *
 * Even-stride sampling rather than averaging, so the swing highs and lows the
 * levels were drawn against survive into the picture.
 */
function toSeries(candles: Candle[], max = SERIES_POINTS): TradeSeriesPoint[] {
  const points = candles.map((c) => ({ time: c.time, close: c.close }));
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as TradeSeriesPoint);
}

function buildInput(args: {
  symbol: string;
  assetClass: AssetClass;
  quote: Quote;
  candles: Candle[];
  name: string | null;
  profile: tradingview.IssuerProfile | null;
  holding?: TradingRequest['holdings'][number];
}): TradeInput {
  const { symbol, assetClass, quote, candles, profile, holding } = args;
  const price = quote.price;
  const technicals = candles.length > 0 ? computeTechnicals(candles) : null;
  // Zero is how the ledger records an unknown cost, so it is not a cost.
  const averageCost = holding && holding.averageCost > 0 ? holding.averageCost : null;
  const fy = profile?.fiscalYearDividend ?? null;

  return {
    symbol,
    assetClass,
    name:
      profile?.name ?? args.name ?? (assetClass === 'commodity' ? metals.displayName(symbol) : null),
    price,
    currency: quote.currency,
    changePercent: quote.changePercent,
    held: Boolean(holding),
    quantity: holding?.quantity ?? null,
    averageCost,
    pnlPercent: averageCost !== null ? ((price - averageCost) / averageCost) * 100 : null,
    technicals,
    fundamentals: profile
      ? {
          sector: profile.sector,
          marketCap: profile.marketCap,
          peRatio: profile.peRatio,
          epsTtm: profile.epsTtm,
        }
      : null,
    dividends:
      fy !== null || (profile?.dividendYield ?? null) !== null
        ? {
            trailingAnnualAmount: fy,
            // Computed from the payout and today's price where both exist, so
            // the figure is reproducible from what the card shows.
            trailingYieldPercent: fy !== null && price > 0 ? (fy / price) * 100 : (profile?.dividendYield ?? null),
          }
        : null,
    series: toSeries(candles),
    tags: chartTags(technicals, price),
  };
}

/** Price, chart and issuer facts for each item, or the reason it could not be planned. */
async function gather(
  items: Array<Item & { name?: string | null; holding?: TradingRequest['holdings'][number] }>,
  skipped: TradingDesk['skipped'],
): Promise<TradeInput[]> {
  const stocks = items.filter((i) => i.assetClass === 'stock').map((i) => i.symbol);
  const [quotes, candles, profiles] = await Promise.all([
    quotesFor(items),
    dailyCandles(items),
    profilesFor(stocks),
  ]);

  const inputs: TradeInput[] = [];
  for (const item of items) {
    const quote = quotes.get(item.symbol);
    if (!quote || quote instanceof Error) {
      skipped.push({ symbol: item.symbol, reason: quote ? reasonOf(quote) : 'could not be priced' });
      continue;
    }
    // A plan without a chart is thin but still a plan; no price is no plan.
    const series = candles.get(item.symbol);
    inputs.push(
      buildInput({
        symbol: item.symbol,
        assetClass: item.assetClass,
        quote,
        candles: Array.isArray(series) ? series : [],
        name: item.name ?? null,
        profile: profiles[item.symbol] ?? null,
        ...(item.holding ? { holding: item.holding } : {}),
      }),
    );
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// The market screen
// ---------------------------------------------------------------------------

interface Shortlist {
  items: Array<Item & { name: string | null }>;
  screened: TradingDesk['screened'];
  skipped: TradingDesk['skipped'];
}

/**
 * Screen one class: chart its liquid universe, score the setups, keep the best.
 * A symbol whose chart cannot be fetched drops out — it was never a candidate —
 * but every chart failing is reported, since that means the provider is down.
 */
async function screenClass(assetClass: 'stock' | 'crypto', owned: Set<string>): Promise<Shortlist> {
  const marketName = assetClass === 'stock' ? 'PSX market' : 'Binance market';
  let rows: MarketRow[];
  let stale: boolean;
  try {
    ({ rows, stale } = await listing(assetClass));
  } catch (err) {
    return {
      items: [],
      screened: [{ assetClass, universe: 0, shortlisted: 0 }],
      skipped: [{ symbol: marketName, reason: `listing unavailable: ${reasonOf(err)}` }],
    };
  }

  const universe =
    assetClass === 'stock'
      ? liquidStocks(rows, owned, UNIVERSE.stock)
      : liquidCoins(rows, owned, UNIVERSE.crypto);
  const charts = await dailyCandles(universe.map((r) => ({ symbol: r.symbol.toUpperCase(), assetClass })));

  const scored = universe.flatMap((row) => {
    const candles = charts.get(row.symbol.toUpperCase());
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const technicals = computeTechnicals(candles);
    // A stale listing still says what trades, but not at what price.
    const price = stale ? (candles[candles.length - 1] as Candle).close : row.price;
    const score = technicals ? setupScore(technicals, price) : null;
    return score === null ? [] : [{ row, score }];
  });

  const skipped: TradingDesk['skipped'] = [];
  const failures = [...charts.values()].filter((c): c is Error => c instanceof Error);
  if (universe.length > 0 && failures.length === universe.length) {
    skipped.push({ symbol: marketName, reason: `no charts could be fetched (${failures[0]?.message})` });
  }

  const best = scored.sort((a, b) => b.score - a.score).slice(0, SHORTLIST);
  return {
    items: best.map(({ row }) => ({ symbol: row.symbol.toUpperCase(), assetClass, name: row.name ?? null })),
    screened: [{ assetClass, universe: universe.length, shortlisted: best.length }],
    skipped,
  };
}

/**
 * The shortlist, held for ten minutes so polling while reviews land keeps the
 * same names on screen — and skips re-charting sixty instruments each time.
 */
async function shortlistFor(
  classes: Array<'stock' | 'crypto'>,
  owned: Set<string>,
  refresh: boolean,
): Promise<Shortlist> {
  const key = `trading:shortlist:${classes.join(',')}:${[...owned].sort().join(',')}`;
  if (!refresh) {
    const hit = cacheGet<Shortlist>(key);
    if (hit) return hit.value;
  }
  const parts = await Promise.all(classes.map((c) => screenClass(c, owned)));
  const merged: Shortlist = {
    items: parts.flatMap((p) => p.items),
    screened: parts.flatMap((p) => p.screened),
    skipped: parts.flatMap((p) => p.skipped),
  };
  cacheSet(key, merged, TTL.tradingShortlist);
  return merged;
}

// ---------------------------------------------------------------------------
// Market context
// ---------------------------------------------------------------------------

async function benchmark(symbol: string, assetClass: AssetClass): Promise<MarketPulse['benchmark']> {
  const candles = (await dailyCandles([{ symbol, assetClass }])).get(symbol);
  const t = Array.isArray(candles) ? computeTechnicals(candles) : null;
  return t ? { symbol, trend: t.trend, rsi14: t.rsi14, changePercent30d: t.changePercent30d } : null;
}

/**
 * Breadth for each class in play, with the KSE-100 and Bitcoin as benchmarks.
 * Best-effort throughout, and a stale listing is left out entirely: its
 * breadth describes some earlier session, not today.
 */
async function marketPulse(classes: AssetClass[]): Promise<MarketPulse[]> {
  const parts = await Promise.all([
    classes.includes('stock')
      ? Promise.all([listing('stock').catch(() => null), benchmark('KSE100', 'stock')]).then(
          ([result, bench]): MarketPulse | null =>
            result && !result.stale && result.rows.length > 0
              ? { assetClass: 'stock', ...breadth(result.rows), benchmark: bench }
              : null,
        )
      : null,
    classes.includes('crypto')
      ? Promise.all([listing('crypto').catch(() => null), benchmark('BTCUSDT', 'crypto')]).then(
          ([result, bench]): MarketPulse | null =>
            result && !result.stale && result.rows.length > 0
              ? {
                  assetClass: 'crypto',
                  // The long tail of USDT pairs is illiquid noise; the 100
                  // most-traded are the meaningful reading.
                  ...breadth(liquidCoins(result.rows, new Set(), 100)),
                  benchmark: bench,
                }
              : null,
        )
      : null,
  ]);
  return parts.filter((p): p is MarketPulse => p !== null);
}

const TREND_WORDS = { up: 'an uptrend', down: 'a downtrend', sideways: 'a sideways range' } as const;

/** The day's backdrop in two or three sentences, from the pulse alone. */
function describeMarket(pulse: MarketPulse[]): string {
  if (pulse.length === 0) {
    return 'Market-wide data is unavailable right now, so each plan is judged on its own chart.';
  }
  const sentences = pulse.map((p) => {
    const bench = p.benchmark
      ? `; ${p.benchmark.symbol === 'KSE100' ? 'the KSE-100' : 'Bitcoin'} is in ${TREND_WORDS[p.benchmark.trend]}` +
        (p.benchmark.rsi14 !== null ? ` (RSI ${Math.round(p.benchmark.rsi14)})` : '')
      : '';
    return p.assetClass === 'stock'
      ? `On the PSX, ${p.advancers} stocks are up and ${p.decliners} down today${bench}.`
      : `Among the 100 most-traded coins, ${p.advancers} are up and ${p.decliners} down over 24 hours${bench}.`;
  });
  if (pulse.some((p) => p.benchmark?.trend === 'down')) {
    sentences.push('A falling benchmark makes dips run deeper, so favour waiting for buy zones over buying now.');
  }
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function tradingRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    // The client polls this while reviews land, and a poll is cheap — inputs
    // are cached and the expensive model calls are deduplicated server-side —
    // so the limit only guards against a runaway loop.
    await scoped.register(import('@fastify/rate-limit'), {
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip,
    });

    /** POST /api/ai/trading */
    scoped.post<{ Body: TradingRequest }>('/api/ai/trading', async (request, reply) => {
      // Phase timings go out as Server-Timing, so the browser's Network tab
      // shows where a slow response spent its time without a server log.
      const started = performance.now();
      const timings: string[] = [];
      const mark = (name: string, from: number) =>
        timings.push(`${name};dur=${(performance.now() - from).toFixed(1)}`);
      const { scope, holdings: rawHoldings, assetClasses, refresh } = request.body ?? {};
      if (scope !== 'holdings' && scope !== 'market') {
        throw AppError.badRequest('scope must be "holdings" or "market"');
      }
      if (!Array.isArray(rawHoldings)) throw AppError.badRequest('holdings must be an array');

      // One row per symbol, open positions only.
      const holdings = [
        ...new Map(
          rawHoldings
            .filter((h) => h && typeof h.symbol === 'string' && Number(h.quantity) > 0)
            .map((h) => [h.symbol.trim().toUpperCase(), { ...h, symbol: h.symbol.trim().toUpperCase() }]),
        ).values(),
      ];
      const owned = new Set(holdings.map((h) => h.symbol));

      // The scan is long-only across the two markets with a liquid universe;
      // spot metals are four instruments and are planned only when held.
      const classes = [...new Set(assetClasses ?? ['stock', 'crypto'])]
        .filter((c): c is 'stock' | 'crypto' => c === 'stock' || c === 'crypto')
        .sort();

      if (scope === 'holdings' && holdings.length === 0) {
        throw AppError.badRequest('No open holdings to plan.');
      }
      if (scope === 'market' && classes.length === 0) {
        throw AppError.badRequest('assetClasses must include "stock" or "crypto".');
      }

      const skipped: TradingDesk['skipped'] = [];
      let screened: TradingDesk['screened'] = [];

      const book = holdings.slice(0, MAX_HOLDINGS).map((holding) => ({
        symbol: holding.symbol,
        assetClass: classify(holding.symbol, holding.assetClass),
        holding,
      }));

      // Market context is independent of the plans' own inputs, so the two
      // are fetched side by side rather than one after the other.
      const pulseStarted = performance.now();
      const pulsePromise = marketPulse(
        scope === 'holdings' ? [...new Set(book.map((b) => b.assetClass))] : classes,
      );

      let inputs: TradeInput[];
      if (scope === 'holdings') {
        for (const h of holdings.slice(MAX_HOLDINGS)) {
          skipped.push({ symbol: h.symbol, reason: `only the first ${MAX_HOLDINGS} holdings are planned` });
        }
        const t = performance.now();
        inputs = await gather(book, skipped);
        mark('gather', t);
      } else {
        let t = performance.now();
        const shortlist = await shortlistFor(classes, owned, Boolean(refresh));
        mark('screen', t);
        screened = shortlist.screened;
        skipped.push(...shortlist.skipped);
        t = performance.now();
        inputs = await gather(shortlist.items, skipped);
        mark('gather', t);
      }
      const pulse = await pulsePromise;
      mark('pulse', pulseStarted);
      const planStarted = performance.now();

      if (inputs.length === 0 && scope === 'holdings') {
        throw AppError.providerError('market', 'None of your holdings could be priced, so there is nothing to plan.');
      }

      // Engine first, review second. A fresh "avoid" from the scan carries no
      // levels, so there is nothing for the model to weigh and it is skipped;
      // everything the investor holds is always reviewed.
      const aiOn = config.providers.ai;
      const plans = inputs.map((asset) => {
        const rule = planByRules(asset);
        const wantsReview = aiOn && (scope === 'holdings' || rule.signal !== 'avoid');
        return finalisePlan(
          asset,
          rule,
          wantsReview ? reviewState(asset, rule, pulse, Boolean(refresh)) : { status: 'skipped' },
        );
      });

      if (scope === 'market') {
        plans.sort(
          (a, b) =>
            SIGNAL_ORDER[a.signal] - SIGNAL_ORDER[b.signal] ||
            CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
            (b.metrics.rewardRisk ?? 0) - (a.metrics.rewardRisk ?? 0),
        );
      }

      const desk: TradingDesk = {
        scope,
        plans,
        marketView: describeMarket(pulse),
        pulse,
        screened,
        skipped,
        aiPending: plans.filter((p) => p.ai.status === 'pending').length,
        generatedAt: Date.now(),
        model: aiOn ? config.ai.model : null,
      };
      mark('plan', planStarted);
      mark('total', started);
      reply.header('server-timing', timings.join(', '));
      return desk;
    });
  });
}
