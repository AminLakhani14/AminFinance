/**
 * The chart engine: a complete trade plan from indicators alone, in
 * microseconds.
 *
 * The trading desk used to ask the model for every level and every sentence,
 * which at the gateway's ~16 tokens a second meant minutes per page. Levels
 * are not where a language model earns its keep anyway — anchoring a buy zone
 * to the nearest support, a target to the next swing high and a stop an ATR
 * below the zone is arithmetic, and arithmetic is reproducible here and was
 * only approximated there. So the engine owns the levels, and the model is
 * asked afterwards, in parallel and in the background, for what rules cannot
 * judge: whether the business or coin deserves holding for years, and whether
 * the setup should be vetoed for a reason the chart cannot see.
 *
 * Rules, all in ATR so they mean the same for a PKR stock and a dollar coin:
 *
 *  - Buy zone: the highest floor within 3 ATR below price — swing support, the
 *    20- or 50-day average, or the lower band — from 0.25 ATR under it to 0.5
 *    ATR over it. Price inside it is a buy now; above it, a buy on the dip.
 *  - Stop: 1 ATR under the lower of the zone and the swing support. For a
 *    long-term holding, 1.5 ATR under the 200-day average instead, so the
 *    stop marks the long-term case breaking rather than an ordinary wobble.
 *  - Target 1: the nearest swing high above the entry, or 2.5 ATR above it
 *    when there is no ceiling overhead. Target 2: the 52-week high when it is
 *    clear of target 1, else 1.5 ATR beyond it.
 *  - A fresh entry needs reward-to-risk of at least 1.5 at target 1, an
 *    uptrend or at least not a downtrend under the 200-day average, and a
 *    floor to buy against. Anything else is "avoid".
 */
import type {
  AssetClass,
  ConfidenceLevel,
  HoldPeriod,
  TechnicalSnapshot,
  TradeSeriesPoint,
  TradeSignal,
} from '@aminfinance/shared';
import { zoneStatusOf } from '@aminfinance/shared';

/** One asset with everything the engine, the model and the card need. */
export interface TradeInput {
  symbol: string;
  assetClass: AssetClass;
  name: string | null;
  price: number;
  currency: string;
  changePercent: number;
  held: boolean;
  quantity: number | null;
  /** Null when the purchase price is unknown. */
  averageCost: number | null;
  pnlPercent: number | null;
  technicals: TechnicalSnapshot | null;
  /** PSX issuers only. */
  fundamentals: {
    sector: string | null;
    marketCap: number | null;
    peRatio: number | null;
    epsTtm: number | null;
  } | null;
  /** PSX issuers only; null when none are on record. */
  dividends: { trailingAnnualAmount: number | null; trailingYieldPercent: number | null } | null;
  /** For the client's chart; not shown to the model. */
  series: TradeSeriesPoint[];
  tags: string[];
}

export interface RulePlan {
  signal: TradeSignal;
  holdPeriod: HoldPeriod;
  confidence: ConfidenceLevel;
  buyZone: [number, number] | null;
  sellTargets: number[];
  stopLoss: number | null;
  summary: string;
  longTermView: string;
  technicalNote: string;
  invalidation: string;
}

/** Coins established enough that holding through a cycle is a defensible default. */
const ESTABLISHED_COINS = new Set(['BTC', 'ETH']);

const COIN_NAMES: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum' };

/** Enough digits to act on, never more than the price itself carries. */
export function priceText(value: number, currency: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function coinBase(symbol: string): string {
  return symbol.replace(/(USDT|FDUSD|USDC|BUSD)$/, '');
}

/** What the engine calls this asset in a sentence. */
function displayName(asset: TradeInput): string {
  if (asset.assetClass === 'crypto') return COIN_NAMES[coinBase(asset.symbol)] ?? coinBase(asset.symbol);
  return asset.name && asset.name.length <= 40 ? asset.name : asset.symbol;
}

/**
 * How long the asset deserves holding, from what the data can show.
 *
 * Deliberately conservative: a rule cannot read a business, so it only calls
 * "long-term" where the numbers say profitable and either cheap or paying, or
 * where the asset is one of the two most established coins or gold. The model
 * revises this when it reviews the plan.
 *
 * For a company the trend is deliberately not an input. A cheap, profitable,
 * dividend-paying business in a downtrend is still worth owning — the trend
 * decides whether to add now, not whether to keep it — and letting a falling
 * price demote it to a trade is how the engine once told the holder of a P/E 9,
 * 7.6%-yield stock to sell. A speculative coin has no business underneath, so
 * for those the trend is the case.
 */
export function ruleHoldPeriod(asset: TradeInput): HoldPeriod {
  const t = asset.technicals;

  if (asset.assetClass === 'crypto') {
    if (ESTABLISHED_COINS.has(coinBase(asset.symbol))) return 'long-term';
    const brokenTrend = t !== null && t.trend === 'down' && t.sma200 !== null && asset.price < t.sma200;
    return t !== null && !brokenTrend && t.trend !== 'down' ? 'medium-term' : 'short-term';
  }
  if (asset.assetClass === 'commodity') {
    return asset.symbol.startsWith('XAU') ? 'long-term' : 'medium-term';
  }

  const pe = asset.fundamentals?.peRatio ?? null;
  const eps = asset.fundamentals?.epsTtm ?? null;
  const dividendYield = asset.dividends?.trailingYieldPercent ?? null;
  const profitable = (pe !== null && pe > 0) || (eps !== null && eps > 0);
  const reasonablyPriced = pe !== null && pe > 0 && pe <= 15;
  const pays = dividendYield !== null && dividendYield >= 4;

  if (profitable && (reasonablyPriced || pays)) return 'long-term';
  if (profitable || t?.trend === 'up') return 'medium-term';
  return 'short-term';
}

function ruleLongTermView(asset: TradeInput, period: HoldPeriod): string {
  const name = displayName(asset);
  const sma200 = asset.technicals?.sma200 ?? null;

  if (period === 'long-term') {
    if (asset.assetClass === 'crypto') {
      return `${name} is one of the two most established crypto networks, so it is reasonable to hold for years — sized so that its large swings never force a sale.`;
    }
    if (asset.assetClass === 'commodity') {
      return 'Gold has kept its value over long periods and tends to hold up when the rupee weakens, which makes it a reasonable long-term holding in small size.';
    }
    const pe = asset.fundamentals?.peRatio ?? null;
    const dy = asset.dividends?.trailingYieldPercent ?? null;
    const facts = [
      pe !== null && pe > 0 ? `earns its price back in about ${pe.toFixed(1)} years of profit` : null,
      dy !== null && dy > 0 ? `pays about ${dy.toFixed(1)}% a year in dividends` : null,
    ].filter(Boolean);
    return `${name} is profitable${facts.length > 0 ? ` — it ${facts.join(' and ')}` : ''} — the kind of business worth holding through normal ups and downs.`;
  }
  if (period === 'medium-term') {
    return `Worth holding for some months while the current rise lasts. Rethink it if the price falls below its long-run average${sma200 !== null ? ` (about ${priceText(sma200, asset.currency)})` : ''}.`;
  }
  return 'A trade rather than an investment: the case rests on the chart, not on lasting value, so sell at the targets and do not hold it through the stop.';
}

interface Floor {
  value: number;
  /** For the plain-English summary. */
  plain: string;
  /** For the auditable technical note. */
  tech: string;
}

function confidenceOf(t: TechnicalSnapshot, price: number, rewardRisk: number | null): ConfidenceLevel {
  let score = 0;
  if (t.trend === 'up') score++;
  if (t.sma200 !== null && price > t.sma200) score++;
  if (t.macd && t.macd.histogram > 0) score++;
  if (rewardRisk !== null && rewardRisk >= 2) score++;
  if (t.rsi14 !== null && t.rsi14 >= 35 && t.rsi14 <= 65) score++;
  return score >= 4 ? 'high' : score >= 2 ? 'moderate' : 'low';
}

const pct = (from: number, to: number): string => `${Math.abs(((to - from) / from) * 100).toFixed(1)}%`;

/** The engine. Pure: same inputs, same plan. */
export function planByRules(asset: TradeInput): RulePlan {
  const t = asset.technicals;
  const price = asset.price;
  const p = (v: number) => priceText(v, asset.currency);
  const holdPeriod = ruleHoldPeriod(asset);
  const longTermView = ruleLongTermView(asset, holdPeriod);

  if (!t || t.bars < 50 || t.atr14 === null || t.atr14 <= 0) {
    return {
      signal: asset.held ? 'hold' : 'avoid',
      holdPeriod,
      confidence: 'low',
      buyZone: null,
      sellTargets: [],
      stopLoss: null,
      summary: asset.held
        ? 'There is not enough price history yet to set buy or sell levels, so hold for now and check back later.'
        : 'There is not enough price history yet to judge an entry. Stay out until a few months of trading have built up.',
      longTermView,
      technicalNote: `Only ${t?.bars ?? 0} daily bars are available; the engine needs at least 50 to set levels.`,
      invalidation: 'Not applicable until there is enough history.',
    };
  }

  const atr = t.atr14;
  const down = t.trend === 'down';
  const below200 = t.sma200 !== null && price < t.sma200;

  // 1. Where to buy: the nearest real floor under the price.
  const floors: Floor[] = [
    t.support !== null
      ? { value: t.support, plain: 'a price where buyers have stepped in before', tech: 'the nearest swing low' }
      : null,
    t.sma20 !== null
      ? { value: t.sma20, plain: 'its average price over the last month', tech: 'the 20-day average' }
      : null,
    t.sma50 !== null
      ? { value: t.sma50, plain: 'its average price over the last ten weeks', tech: 'the 50-day average' }
      : null,
    t.bollinger
      ? { value: t.bollinger.lower, plain: 'the bottom of its usual recent range', tech: 'the lower Bollinger band' }
      : null,
  ].filter((f): f is Floor => f !== null && f.value > 0 && f.value < price);

  const near = floors.filter((f) => price - f.value <= 3 * atr).sort((a, b) => b.value - a.value);
  // Stretched far above every floor: the 20-day average is still where a
  // pullback would most likely find buyers.
  const anchor =
    near[0] ??
    (t.sma20 !== null && t.sma20 < price
      ? { value: t.sma20, plain: 'its average price over the last month', tech: 'the 20-day average' }
      : null);

  const zoneLow = anchor ? anchor.value - 0.25 * atr : null;
  const zone: [number, number] | null =
    anchor && zoneLow !== null && zoneLow > 0 ? [zoneLow, anchor.value + 0.5 * atr] : null;

  // 2. Where the plan is wrong. A long-term holding gets more room, and the
  // 200-day average joins the floors when price is above it, so the stop
  // marks the long-term case breaking rather than an ordinary wobble.
  const longTermHold = asset.held && holdPeriod === 'long-term';
  const longAverage = longTermHold && t.sma200 !== null && t.sma200 < price ? t.sma200 : Number.POSITIVE_INFINITY;
  const stopBase = Math.min(zone?.[0] ?? price, t.support ?? Number.POSITIVE_INFINITY, longAverage);
  const rawStop = stopBase - (longTermHold ? 1.5 : 1) * atr;
  const stop = rawStop > 0 ? rawStop : null;
  const stopSource = longTermHold
    ? `1.5 ATR under the lowest of the zone, the swing low and (when below price) the 200-day average`
    : `1 ATR under the lower of the zone and the swing low`;

  // 3. Where to sell.
  const entry = asset.held || !zone ? price : (zone[0] + zone[1]) / 2;
  const above = Math.max(entry, asset.held ? price : (zone?.[1] ?? price));
  const resistanceAbove = t.resistance !== null && t.resistance > above ? t.resistance : null;
  // A fresh entry is held to the nearest ceiling, however close — that is
  // what keeps a trade pressed under resistance from passing the reward-to-
  // risk test. A held position needs somewhere to actually sell: a ceiling a
  // few ticks above today's price is not a target, so it must clear 1 ATR.
  const usableCeiling =
    resistanceAbove !== null && (!asset.held || resistanceAbove >= price + atr) ? resistanceAbove : null;
  const target1 = usableCeiling ?? above + (asset.held ? 1.5 : 2.5) * atr;
  // The 52-week high is a target only while it is within reach; a spike
  // twice today's price is history, not a plan.
  const yearHighInReach =
    t.high52w !== null && t.high52w > target1 + 0.75 * atr && t.high52w <= target1 + 5 * atr;
  const target2 = yearHighInReach ? (t.high52w as number) : target1 + 1.5 * atr;
  const targets = [target1, target2];
  const t1Source =
    usableCeiling !== null
      ? 'the nearest swing high'
      : `${asset.held ? '1.5' : '2.5'} ATR above ${asset.held ? "today's price" : 'the entry'} (no usable swing high overhead)`;
  const t2Source = yearHighInReach ? 'the 52-week high' : '1.5 ATR beyond target 1';

  const rewardRisk = stop !== null && entry > stop ? (target1 - entry) / (entry - stop) : null;
  const confidence = confidenceOf(t, price, rewardRisk);
  const rsiText = t.rsi14 !== null ? `, RSI ${t.rsi14.toFixed(0)}` : '';

  const technicalNote = [
    zone && anchor
      ? `Zone: ${anchor.tech} at ${p(anchor.value)}, from 0.25 ATR under to 0.5 ATR over (ATR ${p(atr)}).`
      : 'No floor within reach under the price, so no buy zone.',
    `Target 1: ${t1Source}, ${p(target1)}. Target 2: ${t2Source}, ${p(target2)}.`,
    stop !== null ? `Stop: ${stopSource}, ${p(stop)}.` : '',
    rewardRisk !== null ? `Reward to risk at target 1: ${rewardRisk.toFixed(1)}.` : '',
    `Trend ${t.trend}${rsiText}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const invalidation = stop !== null ? `A daily close below ${p(stop)}.` : 'No defensible stop level on this chart.';

  const name = displayName(asset);
  const targetsText = `${p(target1)}, and the rest near ${p(target2)}`;

  // 4. What to do.
  if (!asset.held) {
    const avoid = (summary: string, invalidationText: string): RulePlan => ({
      signal: 'avoid',
      holdPeriod,
      confidence,
      buyZone: null,
      sellTargets: [],
      stopLoss: null,
      summary,
      longTermView,
      technicalNote,
      invalidation: invalidationText,
    });

    if (!zone || !anchor) {
      return avoid(
        `${name} has dropped below every recent floor, so there is no sensible price to buy against yet. Wait for it to steady before looking again.`,
        'A few weeks of higher lows would give the engine a floor to work from.',
      );
    }
    if (down && (below200 || t.sma200 === null)) {
      return avoid(
        `${name} has been falling for months and sits below its long-run average, so a dip is more likely to keep going than to bounce. Stay out until it stops falling.`,
        t.sma200 !== null
          ? `A close back above its 200-day average (${p(t.sma200)}) would change this.`
          : 'An end to the run of lower highs would change this.',
      );
    }
    if (rewardRisk === null || rewardRisk < 1.5) {
      return avoid(
        resistanceAbove !== null
          ? `${name}'s next ceiling, around ${p(resistanceAbove)}, is too close compared with how far it could fall, so the possible gain does not justify the risk today.`
          : `The possible gain from here does not justify how far ${name} could fall, so there is no good trade today.`,
        resistanceAbove !== null
          ? `A close above ${p(resistanceAbove)} would open room to the upside.`
          : 'A pullback towards a floor would improve the odds.',
      );
    }

    const inZone = zoneStatusOf(price, zone) === 'in-zone';
    const gain = pct(entry, target1);
    const risk = pct(entry, stop as number);
    return {
      signal: inZone ? 'buy-now' : 'buy-on-dip',
      holdPeriod,
      confidence,
      buyZone: zone,
      sellTargets: targets,
      stopLoss: stop,
      summary: inZone
        ? `${name} is trading near ${anchor.plain}. Buy between ${p(zone[0])} and ${p(zone[1])}, sell part at ${targetsText}, and get out if it closes below ${p(stop as number)} — risking about ${risk} to make about ${gain}.`
        : `${name} is worth buying, but not at today's ${p(price)}: it is ${pct(zone[1], price)} above ${anchor.plain}. Wait for ${p(zone[0])}–${p(zone[1])}, then sell part at ${targetsText}, and get out if it closes below ${p(stop as number)}.`,
      longTermView,
      technicalNote,
      invalidation,
    };
  }

  // Held: add, hold, take profit or sell.
  const pnl = asset.pnlPercent;
  const pnlText =
    pnl === null ? '' : ` You are ${pnl >= 0 ? 'up' : 'down'} about ${Math.abs(pnl).toFixed(1)}% on it.`;

  if (down && below200 && holdPeriod !== 'long-term') {
    return {
      signal: 'sell',
      holdPeriod,
      confidence,
      buyZone: null,
      sellTargets: [],
      stopLoss: stop,
      summary: `${name} has been falling for months and sits below its long-run average.${pnlText} Selling frees the money for something stronger; if you keep it, get out on a close below ${stop !== null ? p(stop) : 'its recent low'}.`,
      longTermView,
      technicalNote,
      invalidation:
        t.sma200 !== null ? `A close back above its 200-day average (${p(t.sma200)}).` : invalidation,
    };
  }

  const nearCeiling = resistanceAbove !== null && resistanceAbove - price <= atr;
  if (holdPeriod !== 'long-term' && t.rsi14 !== null && t.rsi14 >= 68 && nearCeiling) {
    return {
      signal: 'take-profit',
      holdPeriod,
      confidence,
      buyZone: null,
      sellTargets: targets,
      stopLoss: stop,
      summary: `${name} has climbed close to a ceiling around ${p(resistanceAbove as number)} and looks stretched.${pnlText} Consider selling part between here and ${p(resistanceAbove as number)} to lock in gains, and keep the rest with an exit below ${stop !== null ? p(stop) : 'its recent low'}.`,
      longTermView,
      technicalNote,
      invalidation,
    };
  }

  const canAdd = zone !== null && !down;
  if (canAdd && zoneStatusOf(price, zone) === 'in-zone' && rewardRisk !== null && rewardRisk >= 1.5) {
    return {
      signal: 'add',
      holdPeriod,
      confidence,
      buyZone: zone,
      sellTargets: targets,
      stopLoss: stop,
      summary: `${name} is at a good level to add to: it is near ${anchor?.plain ?? 'a recent floor'}.${pnlText} Add between ${p(zone[0])} and ${p(zone[1])}, sell part at ${targetsText}, and get out on a close below ${p(stop as number)}.`,
      longTermView,
      technicalNote,
      invalidation,
    };
  }

  return {
    signal: 'hold',
    holdPeriod,
    confidence,
    buyZone: canAdd ? zone : null,
    sellTargets: targets,
    stopLoss: stop,
    summary:
      `No action needed — keep it.${pnlText} Consider selling part near ${p(target1)}.` +
      (canAdd && zone ? ` If it dips to ${p(zone[0])}–${p(zone[1])}, that is a good level to add.` : '') +
      (stop !== null ? ` Get out on a close below ${p(stop)}.` : ''),
    longTermView,
    technicalNote,
    invalidation,
  };
}
