/**
 * Binance balance reconciliation.
 *
 * The holdings table is derived purely from the transaction ledger, while the
 * Binance card reads live balances. Those two disagree whenever the exchange
 * moved an asset without producing a spot fill we imported — Earn and staking
 * conversions, airdrops, deposits, withdrawals, or trades in a pair outside
 * the synced set. A fill-based ledger simply cannot reconstruct those.
 *
 * So we close the gap explicitly: for each asset, compare the live balance
 * against what the fills imply and emit an adjusting transaction for the
 * difference. Crucially, an adjustment never invents a price — a quantity we
 * cannot explain gets no cost basis, which `costBasisKnown` already renders
 * as "—" rather than as fabricated profit.
 *
 * Adjustments are keyed by pair rather than by trade id, so re-running the
 * sync replaces the previous adjustment instead of stacking a new one on top.
 */
import type { Transaction } from '@aminfinance/shared';
import type { BinancePosition } from '@/services/endpoints';
import type { PositionResult } from './costBasis';

/** Quantity below which a mismatch is float noise, not a real difference. */
const DUST = 1e-8;

/** Marks a transaction as a reconciliation row rather than a real fill. */
export const RECONCILE_PREFIX = 'binance-balance-';

export function isReconciliation(tx: Transaction): boolean {
  return tx.id.startsWith(RECONCILE_PREFIX);
}

export interface ReconcileResult {
  /** Adjusting transactions to upsert into the ledger. */
  adjustments: Transaction[];
  /** Assets the ledger under-reported — acquired outside spot trading. */
  added: string[];
  /** Assets the ledger over-reported — disposed of outside the synced pairs. */
  reduced: string[];
  /** Pairs closed out entirely because Binance no longer holds the asset. */
  retired: string[];
}

/**
 * Pairs the ledger holds that Binance does not report a balance for.
 *
 * Two ways this happens, and they need the same treatment:
 *   - The asset is gone — sold, withdrawn, or dusted below the threshold.
 *   - The asset was *renamed* by our own merging. An old WBETHUSDT fill has no
 *     live WBETH balance to match once the server folds WBETH into ETH, so
 *     without this the position would linger forever **and** the new ETHUSDT
 *     row would be added alongside it, double-counting the same coin.
 *
 * Only Binance-sourced positions are eligible. A manually entered or CSV
 * position must never be closed out just because it is absent from a Binance
 * balance — the user may well hold it somewhere else.
 */
function findRetiredPairs(
  balances: BinancePosition[],
  positions: Map<string, PositionResult>,
  binanceSourcedPairs: Set<string>,
): string[] {
  const live = new Set(balances.map((b) => b.pair).filter((p): p is string => p !== null));
  return [...positions.entries()]
    .filter(([pair, position]) => position.quantity > DUST && !live.has(pair) && binanceSourcedPairs.has(pair))
    .map(([pair]) => pair);
}

/**
 * Diff live Binance balances against ledger positions.
 *
 * `positions` must be built from fills only; passing previously-generated
 * adjustments back in would make each run chase its own tail.
 */
export function reconcileBalances(
  balances: BinancePosition[],
  positions: Map<string, PositionResult>,
  /**
   * Pairs whose ledger history came from Binance. Only these may be retired
   * when absent from the live balances; anything manual or CSV is left alone.
   */
  binanceSourcedPairs: Set<string> = new Set(positions.keys()),
  now = Date.now(),
): ReconcileResult {
  const adjustments: Transaction[] = [];
  const added: string[] = [];
  const reduced: string[] = [];

  for (const balance of balances) {
    // Without a tradable pair there is no symbol to hold the position under,
    // and nothing to price it with. USDT and other stablecoins land here;
    // they are cash, not a position.
    if (!balance.pair) continue;

    const ledgerQuantity = positions.get(balance.pair)?.quantity ?? 0;
    const delta = balance.total - ledgerQuantity;
    if (Math.abs(delta) <= DUST) continue;

    const quoteAsset = quoteAssetOf(balance.pair);

    if (delta > 0) {
      added.push(balance.asset);
      adjustments.push({
        id: `${RECONCILE_PREFIX}${balance.pair}`,
        symbol: balance.pair,
        assetClass: 'crypto',
        type: 'buy',
        quantity: delta,
        // Zero price, not the market price: this quantity was acquired by
        // some means we have no record of, so its cost is unknown. The cost
        // engine flags `hasUnknownCost` on a zero-priced buy, which is
        // exactly the honest outcome.
        price: 0,
        fee: 0,
        currency: quoteAsset,
        timestamp: now,
        source: 'binance',
        notes: reconcileNote(balance, delta, 'added'),
      });
    } else {
      reduced.push(balance.asset);
      adjustments.push({
        id: `${RECONCILE_PREFIX}${balance.pair}`,
        symbol: balance.pair,
        assetClass: 'crypto',
        type: 'sell',
        quantity: -delta,
        // A sell at zero would book a 100% realized loss against the lots it
        // consumes. We do not know the disposal price — and for a withdrawal
        // or transfer there was no disposal at all — so the cost engine's
        // "sold more than we bought" path is the wrong shape here too.
        // Pricing the write-down at average cost makes it P/L-neutral: the
        // units leave the book without inventing a gain or a loss.
        price: averageCostOf(positions, balance.pair),
        fee: 0,
        currency: quoteAsset,
        timestamp: now,
        source: 'binance',
        notes: reconcileNote(balance, delta, 'reduced'),
      });
    }
  }

  // Close out anything Binance no longer reports — including positions whose
  // ticker we merged away, which would otherwise sit beside their replacement.
  const retired = findRetiredPairs(balances, positions, binanceSourcedPairs);
  for (const pair of retired) {
    const position = positions.get(pair);
    if (!position) continue;
    adjustments.push({
      id: `${RECONCILE_PREFIX}${pair}`,
      symbol: pair,
      assetClass: 'crypto',
      type: 'sell',
      quantity: position.quantity,
      // At average cost, so retiring a renamed ticker is P/L-neutral. The
      // coin did not leave your account; only the name we file it under did.
      price: position.averageCost,
      fee: 0,
      currency: quoteAssetOf(pair),
      timestamp: now,
      source: 'binance',
      notes: `Balance adjustment: Binance no longer reports a ${pair} balance. Closed out at average cost, so no gain or loss is booked. If this asset was staked or wrapped, it now appears under its underlying ticker.`,
    });
  }

  return { adjustments, added, reduced, retired };
}

/**
 * Average cost of the open lots, used to make a write-down P/L-neutral.
 *
 * Falls back to zero when the position is unknown to the ledger, which cannot
 * happen for a reduction (a reduction implies lots exist) but keeps the
 * function total.
 */
function averageCostOf(positions: Map<string, PositionResult>, pair: string): number {
  return positions.get(pair)?.averageCost ?? 0;
}

function quoteAssetOf(pair: string): string {
  for (const quote of ['USDT', 'FDUSD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB']) {
    if (pair.endsWith(quote)) return quote;
  }
  return 'USDT';
}

function reconcileNote(
  balance: BinancePosition,
  delta: number,
  direction: 'added' | 'reduced',
): string {
  const wrapped =
    balance.wrappedFrom && balance.wrappedFrom.length > 0
      ? ` Includes ${balance.wrappedFrom.join(', ')} held via Earn/staking.`
      : '';

  return direction === 'added'
    ? `Balance adjustment: Binance holds ${balance.total} ${balance.asset}, ${Math.abs(delta)} more than the imported fills account for — acquired via Earn, staking, an airdrop, or a transfer, so cost basis is unknown.${wrapped}`
    : `Balance adjustment: Binance holds ${balance.total} ${balance.asset}, ${Math.abs(delta)} less than the imported fills account for — withdrawn, transferred, or traded in a pair outside the synced set. Written down at average cost, so no gain or loss is booked.${wrapped}`;
}
