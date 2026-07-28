/**
 * Binance account routes — the CORS-blocked half that only a server can reach.
 *
 * These return your balances and fills. The API secret never leaves the server
 * process; only derived data crosses to the browser.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BinanceAccount, BinanceTrade, Transaction } from '@aminfinance/shared';
import { CACHE_HEADERS } from '@aminfinance/shared';
import * as binance from '../providers/binance.js';
import { cached, TTL } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

/** Dust threshold — below this a balance is noise, not a position. */
const MIN_USD_VALUE = 1;

function requireConfigured(): void {
  if (!config.providers.binanceAccount) {
    throw AppError.notConfigured('Binance account sync', 'BINANCE_API_KEY and BINANCE_API_SECRET');
  }
}

function setCache(reply: FastifyReply, meta: { hit: boolean; ageSeconds: number; stale: boolean }): void {
  reply.header(CACHE_HEADERS.status, meta.hit ? 'hit' : 'miss');
  reply.header(CACHE_HEADERS.age, String(meta.ageSeconds));
  if (meta.stale) reply.header(CACHE_HEADERS.stale, 'true');
}

export async function binanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/binance/balances
   *
   * Non-zero spot balances, each priced and mapped to its tradable pair so the
   * client can value the position without a second round trip.
   */
  app.get('/api/binance/balances', async (_request, reply) => {
    requireConfigured();

    const result = await cached<BinanceAccount>(
      'binance:account',
      TTL.binanceAccount,
      () => binance.getAccount(),
    );

    // Resolve each asset to a priceable pair and quote them in one batch.
    const assets = result.value.balances.map((b) => b.asset);
    const pairMap = new Map<string, string>();
    await Promise.all(
      assets.map(async (asset) => {
        const pair = await binance.resolvePair(asset);
        if (pair) pairMap.set(asset, pair);
      }),
    );

    const pairs = [...new Set(pairMap.values())];
    const quotes = pairs.length > 0 ? await binance.getQuotes(pairs) : [];
    const priceByPair = new Map(quotes.map((q) => [q.symbol, q.price]));

    const positions = result.value.balances
      .map((balance) => {
        const pair = pairMap.get(balance.asset);
        // Stablecoins have no pair and are worth ~1 USDT each.
        const price = pair ? (priceByPair.get(pair) ?? null) : 1;
        const valueUsdt = price !== null ? balance.total * price : null;
        return {
          ...balance,
          pair: pair ?? null,
          price,
          valueUsdt,
        };
      })
      .filter((p) => p.valueUsdt === null || p.valueUsdt >= MIN_USD_VALUE)
      .sort((a, b) => (b.valueUsdt ?? 0) - (a.valueUsdt ?? 0));

    const totalUsdt = positions.reduce((sum, p) => sum + (p.valueUsdt ?? 0), 0);

    setCache(reply, result);
    return {
      positions,
      totalUsdt,
      canTrade: result.value.canTrade,
      canWithdraw: result.value.canWithdraw,
      updateTime: result.value.updateTime,
    };
  });

  /**
   * GET /api/binance/trades?symbols=BTCUSDT,XRPUSDT
   *
   * Fills converted to our Transaction shape, ready to import. `externalId` is
   * set from the Binance trade id so re-syncing an overlapping window is
   * idempotent — without it every sync would double the position.
   */
  app.get<{ Querystring: { symbols?: string } }>(
    '/api/binance/trades',
    async (request, reply) => {
      requireConfigured();

      const raw = (request.query.symbols ?? '').trim();
      if (!raw) throw AppError.badRequest('Provide ?symbols=BTCUSDT,ETHUSDT');

      const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
      if (symbols.length > 20) throw AppError.badRequest('Too many symbols (max 20).');

      const results = await Promise.allSettled(
        symbols.map((symbol) =>
          cached<BinanceTrade[]>(
            `binance:trades:${symbol}`,
            TTL.binanceTrades,
            () => binance.getTrades(symbol),
          ),
        ),
      );

      const transactions: Transaction[] = [];
      const errors: Record<string, string> = {};

      results.forEach((result, i) => {
        const symbol = symbols[i] as string;
        if (result.status === 'rejected') {
          errors[symbol] = result.reason instanceof Error ? result.reason.message : 'failed';
          return;
        }
        for (const trade of result.value.value) {
          transactions.push(toTransaction(trade));
        }
      });

      transactions.sort((a, b) => a.timestamp - b.timestamp);

      setCache(reply, { hit: false, ageSeconds: 0, stale: false });
      return {
        transactions,
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      };
    },
  );
}

/**
 * Map a Binance fill to a Transaction.
 *
 * The commission is charged in an arbitrary asset (often BNB). Converting it
 * to the quote currency would need that asset's price at fill time, which we
 * do not have — so it is only counted when it is already denominated in the
 * quote asset, and left at 0 otherwise. Understating a fee slightly is honest;
 * inventing an exchange rate is not.
 */
function toTransaction(trade: BinanceTrade): Transaction {
  const quoteAsset = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB'].find((q) =>
    trade.symbol.endsWith(q),
  );
  const feeInQuote = trade.commissionAsset === quoteAsset ? trade.commission : 0;

  return {
    id: `binance-${trade.id}`,
    symbol: trade.symbol,
    assetClass: 'crypto',
    type: trade.isBuyer ? 'buy' : 'sell',
    quantity: trade.quantity,
    price: trade.price,
    fee: feeInQuote,
    currency: quoteAsset ?? 'USDT',
    timestamp: trade.time,
    source: 'binance',
    externalId: String(trade.id),
    ...(feeInQuote === 0 && trade.commission > 0
      ? { notes: `Fee ${trade.commission} ${trade.commissionAsset} not included in cost basis` }
      : {}),
  };
}
