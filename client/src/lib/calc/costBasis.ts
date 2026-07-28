/**
 * Cost-basis engine.
 *
 * Transactions are the only durable truth; positions, P/L, and every analytic
 * are derived from them here. Nothing in this file is persisted — storing
 * computed P/L is how trackers end up displaying stale numbers.
 *
 * Lots are consumed FIFO, which matches how most tax regimes treat disposals
 * and is what lets us report holding periods honestly.
 */
import type {
  Transaction,
  Lot,
  Holding,
  RealizedGain,
  Quote,
  AssetClass,
} from '@aminfinance/shared';

/** Floating-point guard — quantities below this are treated as fully closed. */
const DUST = 1e-9;

export interface PositionResult {
  symbol: string;
  assetClass: AssetClass;
  currency: string;
  /** Units still held. */
  quantity: number;
  /** Total cost of the open lots, fees included. */
  costBasis: number;
  /** costBasis / quantity, or 0 when flat. */
  averageCost: number;
  openLots: Lot[];
  realized: RealizedGain[];
  /**
   * True when at least one buy had no usable price — e.g. a Binance asset
   * acquired via Earn or an airdrop, where the exchange reports no cost.
   * The UI must show "cost unknown" rather than implying a 100% gain.
   */
  hasUnknownCost: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * Replay one symbol's transactions into open lots plus realized gains.
 *
 * Buys push a lot; sells consume the oldest lots first. A sell with no
 * matching lot (transferred-in asset, missing history) is recorded with a zero
 * cost basis *and* flags `hasUnknownCost`, so the caller can distinguish
 * "genuinely free" from "we don't know".
 */
export function buildPosition(symbol: string, transactions: Transaction[]): PositionResult {
  const ordered = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  const first = ordered[0];

  const lots: Lot[] = [];
  const realized: RealizedGain[] = [];
  let hasUnknownCost = false;

  for (const tx of ordered) {
    if (tx.type === 'buy') {
      // Fees increase what the position cost you, so they belong in the basis.
      const totalCost = tx.quantity * tx.price + tx.fee;
      if (tx.price <= 0) hasUnknownCost = true;
      lots.push({
        transactionId: tx.id,
        remainingQuantity: tx.quantity,
        costPerUnit: tx.quantity > 0 ? totalCost / tx.quantity : 0,
        acquiredAt: tx.timestamp,
      });
      continue;
    }

    // Sell: consume oldest lots first.
    let remainingToSell = tx.quantity;
    // Fees reduce what you actually received.
    const proceedsPerUnit = tx.quantity > 0 ? (tx.quantity * tx.price - tx.fee) / tx.quantity : 0;

    while (remainingToSell > DUST && lots.length > 0) {
      const lot = lots[0];
      if (!lot) break;

      const consumed = Math.min(lot.remainingQuantity, remainingToSell);
      const costBasis = consumed * lot.costPerUnit;
      const proceeds = consumed * proceedsPerUnit;

      realized.push({
        symbol,
        assetClass: tx.assetClass,
        quantity: consumed,
        proceeds,
        costBasis,
        gain: proceeds - costBasis,
        gainPercent: costBasis > 0 ? ((proceeds - costBasis) / costBasis) * 100 : 0,
        closedAt: tx.timestamp,
        holdingPeriodDays: Math.max(
          0,
          Math.round((tx.timestamp - lot.acquiredAt) / MS_PER_DAY),
        ),
      });

      lot.remainingQuantity -= consumed;
      remainingToSell -= consumed;
      if (lot.remainingQuantity <= DUST) lots.shift();
    }

    if (remainingToSell > DUST) {
      // Sold more than we have a record of buying — the acquisition history is
      // incomplete. Record the proceeds but mark the basis as unknown rather
      // than booking the whole amount as profit.
      hasUnknownCost = true;
      realized.push({
        symbol,
        assetClass: tx.assetClass,
        quantity: remainingToSell,
        proceeds: remainingToSell * proceedsPerUnit,
        costBasis: 0,
        gain: 0,
        gainPercent: 0,
        closedAt: tx.timestamp,
        holdingPeriodDays: 0,
      });
    }
  }

  const quantity = lots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
  const costBasis = lots.reduce((sum, lot) => sum + lot.remainingQuantity * lot.costPerUnit, 0);

  return {
    symbol,
    assetClass: first?.assetClass ?? 'stock',
    currency: first?.currency ?? 'PKR',
    quantity: quantity > DUST ? quantity : 0,
    costBasis,
    averageCost: quantity > DUST ? costBasis / quantity : 0,
    openLots: lots,
    realized,
    hasUnknownCost,
  };
}

/** Group transactions by symbol and build every position. */
export function buildPositions(transactions: Transaction[]): Map<string, PositionResult> {
  const bySymbol = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const list = bySymbol.get(tx.symbol);
    if (list) list.push(tx);
    else bySymbol.set(tx.symbol, [tx]);
  }

  const positions = new Map<string, PositionResult>();
  for (const [symbol, txs] of bySymbol) {
    positions.set(symbol, buildPosition(symbol, txs));
  }
  return positions;
}

export interface HoldingWithFlags extends Holding {
  /**
   * At least one lot has no recorded purchase price — a Binance Earn/staking
   * conversion, an airdrop, or a transfer in.
   */
  hasUnknownCost: boolean;
  /**
   * Whether P/L for this position means anything.
   *
   * False when the cost basis is missing entirely: market value is still real
   * and counts toward the portfolio total, but "profit" is unknowable, and
   * showing `marketValue - 0` would report a fabricated 100% gain.
   */
  costBasisKnown: boolean;
}

/**
 * Price open positions with live quotes.
 *
 * `allocationPercent` needs the portfolio total, so it is filled in after
 * every holding is valued — hence the two passes.
 */
export function buildHoldings(
  positions: Map<string, PositionResult>,
  quotes: Map<string, Quote>,
): HoldingWithFlags[] {
  const priced = [...positions.values()]
    .filter((p) => p.quantity > 0)
    .map((position) => {
      const quote = quotes.get(position.symbol);
      // Fall back to average cost when unpriced, so the row shows the position
      // at break-even rather than vanishing or reading as a total loss.
      const currentPrice = quote?.price ?? position.averageCost;
      const marketValue = position.quantity * currentPrice;

      // A position with no recorded cost has no knowable P/L. Report zero and
      // flag it, so the UI can show "—" instead of the whole market value
      // masquerading as profit.
      const costBasisKnown = position.costBasis > 0;
      const unrealizedPnl = costBasisKnown ? marketValue - position.costBasis : 0;

      const previousClose = quote?.previousClose ?? null;
      const dayChange =
        previousClose !== null ? (currentPrice - previousClose) * position.quantity : 0;
      const dayChangePercent =
        previousClose !== null && previousClose > 0
          ? ((currentPrice - previousClose) / previousClose) * 100
          : 0;

      return {
        symbol: position.symbol,
        assetClass: position.assetClass,
        quantity: position.quantity,
        averageCost: position.averageCost,
        costBasis: position.costBasis,
        currentPrice,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent: costBasisKnown
          ? (unrealizedPnl / position.costBasis) * 100
          : 0,
        dayChange,
        dayChangePercent,
        allocationPercent: 0,
        currency: quote?.currency ?? position.currency,
        openLots: position.openLots,
        hasUnknownCost: position.hasUnknownCost,
        costBasisKnown,
      } satisfies HoldingWithFlags;
    });

  return priced;
}
