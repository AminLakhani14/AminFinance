/**
 * AI review of the chart engine's trade plans — one small call per asset, in
 * parallel, in the background.
 *
 * The engine (`lib/tradeRules.ts`) produces every level instantly. What it
 * cannot do is read a business or a coin, so each plan is put to the model
 * with the data behind it and three questions: does the signal stand, how long
 * does this deserve holding, and how would you explain it to a beginner? The
 * reply is a few short fields, so a review lands in about ten seconds, and the
 * gateway runs them concurrently — a whole book is reviewed in roughly the
 * time one asset takes.
 *
 * Nothing here blocks a request. `reviewState` reports what is cached, starts
 * what is missing, and returns at once; the client polls until every review
 * has landed. Levels never come from the model: it may veto a setup, not
 * redraw it, so the numbers on screen are always the engine's reproducible
 * ones.
 */
import { z } from 'zod';
import type {
  ConfidenceLevel,
  HoldPeriod,
  MarketPulse,
  TradeAiState,
  TradePlan,
  TradePlanMetrics,
  TradeSignal,
} from '@aminfinance/shared';
import { zoneStatusOf } from '@aminfinance/shared';
import { config } from '../config.js';
import { get as cacheGet, set as cacheSet, TTL } from '../lib/cache.js';
import { priceText, type RulePlan, type TradeInput } from '../lib/tradeRules.js';
import { ASSET_DESCRIPTION, SYSTEM_PROMPT, complete, formatTechnicals } from './ai.js';

const SIGNALS = ['buy-now', 'buy-on-dip', 'avoid', 'add', 'hold', 'take-profit', 'sell'] as const;
const HOLD_PERIODS = ['long-term', 'medium-term', 'short-term'] as const;
const CONFIDENCE = ['low', 'moderate', 'high'] as const;

/** Reviews in flight at once. The gateway runs these in parallel. */
const MAX_CONCURRENT = 8;
/** A short reply; a cap keeps a runaway one from holding a slot for minutes. */
const REVIEW_MAX_TOKENS = 700;
const REVIEW_TIMEOUT_MS = 90_000;
/** How long a failure is reported before the next request may retry it. */
const FAILURE_HOLD_MS = 2 * 60_000;

export interface AiReview {
  signal: TradeSignal;
  holdPeriod: HoldPeriod;
  confidence: ConfidenceLevel;
  summary: string;
  longTermView: string;
  model: string;
  generatedAt: number;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    signal: { type: 'string', enum: SIGNALS },
    holdPeriod: { type: 'string', enum: HOLD_PERIODS },
    confidence: { type: 'string', enum: CONFIDENCE },
    summary: { type: 'string', description: 'Two or three plain sentences, no jargon' },
    longTermView: { type: 'string', description: 'One or two sentences' },
  },
  required: ['signal', 'holdPeriod', 'confidence', 'summary', 'longTermView'],
  additionalProperties: false,
} as const;

const REVIEW_OUTPUT = z.object({
  signal: z.enum(SIGNALS),
  holdPeriod: z.enum(HOLD_PERIODS),
  confidence: z.enum(CONFIDENCE),
  summary: z.string(),
  longTermView: z.string(),
});

const INSTRUCTIONS = `A rules-based chart engine has drawn a trade plan for one asset in this investor's book or watchlist. Its levels are fixed — buy zone, sell targets and stop come from support, resistance, moving averages and ATR. Your job is the judgement the rules cannot make.

Return:
- signal: keep the engine's signal unless you have a reason the chart alone cannot show — the business, its profits, valuation or dividend, the coin's standing, or the market backdrop. Not held: \`buy-now\`, \`buy-on-dip\` or \`avoid\`. Held: \`add\`, \`hold\`, \`take-profit\` or \`sell\`. You may turn a buy into \`avoid\`, but not an \`avoid\` into a buy — there are no levels to buy at.
- holdPeriod: \`long-term\` (worth owning for a year or more through normal swings — a profitable business with durable earnings or a dependable dividend at a sensible price, or an established network such as Bitcoin or Ethereum), \`medium-term\` (a few months while the trend or story plays out) or \`short-term\` (a trade, not an investment). Be selective: speculative coins, loss-making or richly valued companies, and long downtrends are not long-term.
- confidence: low, moderate or high.
- summary: two or three plain sentences for someone who has never read a chart — what to do, at which prices (round them sensibly), and why. No indicator names, no jargon.
- longTermView: one or two sentences — what the company or coin actually is, and whether it is worth owning for years.`;

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatProfile(asset: TradeInput): string {
  if (asset.assetClass !== 'stock') {
    return `- No issuer accounts: a ${ASSET_DESCRIPTION[asset.assetClass]}.`;
  }
  const f = asset.fundamentals;
  const money = (v: number | null): string =>
    v === null ? 'unavailable' : `${Math.round(v).toLocaleString()} ${asset.currency}`;
  const d = asset.dividends;
  return [
    `- Sector: ${f?.sector ?? 'unavailable'}`,
    `- Market cap: ${money(f?.marketCap ?? null)}`,
    `- P/E (TTM): ${f?.peRatio?.toFixed(2) ?? 'unavailable'}`,
    `- EPS (TTM): ${f?.epsTtm?.toFixed(2) ?? 'unavailable'}`,
    d && d.trailingAnnualAmount !== null
      ? `- Dividends, last fiscal year: ${d.trailingAnnualAmount.toFixed(2)} ${asset.currency} per share` +
        (d.trailingYieldPercent !== null ? ` (${d.trailingYieldPercent.toFixed(2)}% of today's price)` : '')
      : '- Dividends: none on record.',
  ].join('\n');
}

function formatPosition(asset: TradeInput): string {
  if (!asset.held) return '- Not held: this is a possible fresh entry.';
  if (asset.averageCost === null) {
    return `- HELD: ${asset.quantity} units, purchase price unknown. Assume neither a profit nor a loss.`;
  }
  return (
    `- HELD: ${asset.quantity} units at average cost ${asset.averageCost} ${asset.currency}` +
    (asset.pnlPercent !== null ? `, unrealised P/L ${signed(asset.pnlPercent)}%` : '')
  );
}

export function formatPulse(pulse: MarketPulse[]): string {
  if (pulse.length === 0) return '## Market today\nNo market-wide data available.';
  const lines = pulse.map((p) => {
    const total = p.advancers + p.decliners + p.unchanged;
    const label = p.assetClass === 'stock' ? 'PSX today' : 'Crypto, 100 most-traded USDT pairs over 24h';
    let line = `- ${label}: ${p.advancers} advancing, ${p.decliners} declining of ${total}.`;
    if (p.benchmark) {
      const b = p.benchmark;
      line +=
        ` ${b.symbol} trend ${b.trend}` +
        (b.rsi14 !== null ? `, RSI(14) ${b.rsi14.toFixed(1)}` : '') +
        (b.changePercent30d !== null ? `, ${signed(b.changePercent30d, 1)}% over 30 sessions` : '') +
        '.';
    }
    return line;
  });
  return ['## Market today', ...lines].join('\n');
}

function formatRulePlan(asset: TradeInput, rule: RulePlan): string {
  const p = (v: number) => priceText(v, asset.currency);
  return [
    "## The chart engine's plan",
    `- Signal: ${rule.signal}`,
    `- Buy zone: ${rule.buyZone ? `${p(rule.buyZone[0])} to ${p(rule.buyZone[1])}` : 'none'}`,
    `- Sell targets: ${rule.sellTargets.length > 0 ? rule.sellTargets.map(p).join(', ') : 'none'}`,
    `- Stop: ${rule.stopLoss !== null ? p(rule.stopLoss) : 'none'}`,
    `- Hold period: ${rule.holdPeriod}`,
    `- Engine's reading: ${rule.technicalNote}`,
  ].join('\n');
}

/** One asset, one short call. */
async function reviewTrade(asset: TradeInput, rule: RulePlan, pulse: MarketPulse[]): Promise<AiReview> {
  const name = asset.name && asset.name !== asset.symbol ? ` — ${asset.name}` : '';
  const userContent = [
    INSTRUCTIONS,
    '',
    `### ${asset.symbol}${name} (${ASSET_DESCRIPTION[asset.assetClass]})`,
    `- Price: ${asset.price} ${asset.currency} (${signed(asset.changePercent)}% on the session)`,
    formatPosition(asset),
    formatProfile(asset),
    '',
    asset.technicals
      ? formatTechnicals(asset.technicals, asset.currency)
      : '## Chart\nNo indicator data — too few candles.',
    '',
    formatRulePlan(asset, rule),
    '',
    formatPulse(pulse),
  ].join('\n');

  const parsed = await complete(
    SYSTEM_PROMPT,
    userContent,
    { name: 'trade_review', schema: REVIEW_SCHEMA, output: REVIEW_OUTPUT },
    { gate: false, maxTokens: REVIEW_MAX_TOKENS, timeoutMs: REVIEW_TIMEOUT_MS },
  );
  return { ...parsed, model: config.ai.model, generatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<void>>();
const failures = new Map<string, { message: string; at: number }>();
let active = 0;
const waiting: Array<() => void> = [];

/** Run `task` once fewer than `MAX_CONCURRENT` reviews are in flight. */
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Pakistan's calendar day — a review is of today's chart, so a new day asks again. */
function pktDay(): string {
  return new Date(Date.now() + 5 * 60 * 60_000).toISOString().slice(0, 10);
}

/** Signals that call for the same judgement share a review. */
function signalFamily(signal: TradeSignal): string {
  return signal === 'buy-now' || signal === 'buy-on-dip' ? 'buy' : signal;
}

/**
 * What a review is of: the asset, the position in it, the day, and the kind
 * of call the engine made. Deliberately not the exact levels — those drift
 * with every tick, and keying on them would re-ask the model all day.
 */
function reviewKey(asset: TradeInput, rule: RulePlan): string {
  const position = asset.held ? `${asset.quantity}@${asset.averageCost ?? 'unknown'}` : 'none';
  return `ai:trade-review:v1:${asset.symbol}:${position}:${pktDay()}:${signalFamily(rule.signal)}`;
}

export interface ReviewState {
  review: AiReview | null;
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
}

/**
 * The review for this plan if there is one, and a job started if there is
 * not. Returns immediately. With `refresh`, a fresh review is started even
 * over a cached one, which keeps showing until the new one lands.
 */
export function reviewState(
  asset: TradeInput,
  rule: RulePlan,
  pulse: MarketPulse[],
  refresh: boolean,
): ReviewState {
  const key = reviewKey(asset, rule);
  const cached = cacheGet<AiReview>(key)?.value ?? null;

  if (running.has(key)) return { review: cached, status: 'pending', error: null };
  if (cached && !refresh) return { review: cached, status: 'ready', error: null };

  const failure = failures.get(key);
  if (failure && !refresh && Date.now() - failure.at < FAILURE_HOLD_MS) {
    return { review: cached, status: 'failed', error: failure.message };
  }
  failures.delete(key);

  const job = withSlot(() => reviewTrade(asset, rule, pulse))
    .then((review) => cacheSet(key, review, TTL.aiTrading, true))
    .catch((err: unknown) => {
      failures.set(key, {
        message: err instanceof Error ? err.message : 'The AI review failed.',
        at: Date.now(),
      });
    })
    .finally(() => running.delete(key));
  running.set(key, job);

  return { review: cached, status: 'pending', error: null };
}

// ---------------------------------------------------------------------------
// Merging and finishing a plan
// ---------------------------------------------------------------------------

/** Finite, positive, ascending, de-duplicated. */
function cleanPrices(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))].sort((a, b) => a - b);
}

/**
 * Hold a reviewed signal to what the position and the levels allow.
 *
 * "Avoid" on something already owned has no executable meaning, nor does
 * "add" on something that is not. A fresh entry can only be a buy when the
 * engine drew a zone to buy in, and `buy-now` versus `buy-on-dip` is settled
 * by where price actually is against that zone, whatever the label said.
 */
function reconcileSignal(
  signal: TradeSignal,
  held: boolean,
  zone: [number, number] | null,
  price: number,
): TradeSignal {
  if (held) {
    if (signal === 'buy-now' || signal === 'buy-on-dip') return zone ? 'add' : 'hold';
    if (signal === 'avoid') return 'hold';
    if (signal === 'add' && !zone) return 'hold';
    return signal;
  }
  if (signal === 'hold' || signal === 'take-profit' || signal === 'sell' || signal === 'avoid') return 'avoid';
  if (!zone) return 'avoid';
  return zoneStatusOf(price, zone) === 'above' ? 'buy-on-dip' : 'buy-now';
}

const ENTRY_SIGNALS = new Set<TradeSignal>(['buy-now', 'buy-on-dip', 'add']);

/**
 * The plan the client renders: the engine's levels, the review's judgement
 * where there is one, and every figure derived from the two.
 *
 * When a review vetoes a fresh entry the levels are dropped with it — an
 * "avoid" card showing a buy zone would contradict itself — and the engine's
 * original call is kept in `ai.engineSignal` so the card can say what changed.
 */
export function finalisePlan(
  asset: TradeInput,
  rule: RulePlan,
  state: ReviewState | { status: 'skipped' },
): TradePlan {
  const price = asset.price;
  const review = 'review' in state ? state.review : null;

  let signal = review ? reconcileSignal(review.signal, asset.held, rule.buyZone, price) : rule.signal;
  // A held position the review says to sell or trim no longer has an add zone.
  let buyZone = rule.buyZone;
  let sellTargets = cleanPrices(rule.sellTargets);
  let stopLoss = rule.stopLoss;
  if (signal === 'sell' || signal === 'take-profit') buyZone = null;
  if (signal === 'sell') sellTargets = [];
  if (!asset.held && signal === 'avoid') {
    buyZone = null;
    sellTargets = [];
    stopLoss = null;
  }
  if (!asset.held && signal !== 'avoid' && !buyZone) signal = 'avoid';

  const entry = asset.held || !buyZone ? price : (buyZone[0] + buyZone[1]) / 2;
  const firstTarget = sellTargets.find((t) => t > entry) ?? null;
  const zoneStatus = zoneStatusOf(price, buyZone);

  // Measured from where money goes in: the zone for a position not yet open,
  // today's price for one already held.
  const metrics: TradePlanMetrics = {
    upsidePercent: firstTarget !== null ? ((firstTarget - entry) / entry) * 100 : null,
    downsidePercent: stopLoss !== null ? ((stopLoss - entry) / entry) * 100 : null,
    // An entry measure: on a hold or an exit it would grade a long-term stop
    // against a near target and read as a warning about a trade nobody is
    // proposing.
    rewardRisk:
      ENTRY_SIGNALS.has(signal) && firstTarget !== null && stopLoss !== null && entry > stopLoss
        ? (firstTarget - entry) / (entry - stopLoss)
        : null,
    zoneStatus,
    distanceToZonePercent:
      buyZone === null ? null : zoneStatus === 'above' ? ((price - buyZone[1]) / price) * 100 : 0,
  };

  const ai: TradeAiState =
    state.status === 'skipped'
      ? { status: 'skipped', engineSignal: null, model: null, generatedAt: null, error: null }
      : {
          status: state.status,
          engineSignal: review && signal !== rule.signal ? rule.signal : null,
          model: review?.model ?? null,
          generatedAt: review?.generatedAt ?? null,
          error: state.error,
        };

  return {
    symbol: asset.symbol,
    assetClass: asset.assetClass,
    currency: asset.currency,
    name: asset.name,
    price,
    changePercent: asset.changePercent,
    series: asset.series,
    held: asset.held,
    position:
      asset.held && asset.quantity !== null
        ? { quantity: asset.quantity, averageCost: asset.averageCost ?? 0, pnlPercent: asset.pnlPercent }
        : null,
    signal,
    holdPeriod: review?.holdPeriod ?? rule.holdPeriod,
    confidence: review?.confidence ?? rule.confidence,
    buyZone,
    sellTargets,
    stopLoss,
    metrics,
    summary: review?.summary ?? rule.summary,
    longTermView: review?.longTermView ?? rule.longTermView,
    technicalNote: rule.technicalNote,
    invalidation: rule.invalidation,
    tags: asset.tags,
    technicals: asset.technicals,
    ai,
  };
}
