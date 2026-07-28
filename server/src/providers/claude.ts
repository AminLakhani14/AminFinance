/**
 * AI insights via the Claude API.
 *
 * Runs server-side, so the SDK is used normally — no `dangerouslyAllowBrowser`,
 * and the key never reaches the browser.
 *
 * Output is constrained with structured outputs (JSON schema) so the client
 * renders typed components instead of parsing prose. The schemas below must
 * stay in sync with `shared/src/ai.ts`.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  AssetInsight,
  PortfolioReview,
  InsightDataSnapshot,
} from '@aminfinance/shared';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';
import { config } from '../config.js';

const MODEL = 'claude-opus-5';
const PROVIDER = 'Claude';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.providers.anthropic) {
    throw AppError.notConfigured('Claude', 'ANTHROPIC_API_KEY');
  }
  client ??= new Anthropic({ apiKey: config.keys.anthropic });
  return client;
}

async function gate(): Promise<void> {
  try {
    await acquire('anthropic', 15_000);
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('anthropic'));
  }
}

const insightPointSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short label, 2-5 words' },
    detail: { type: 'string', description: 'One to three sentences of reasoning' },
  },
  required: ['title', 'detail'],
  additionalProperties: false,
} as const;

const ASSET_INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['buy', 'hold', 'reduce', 'sell'] },
    confidence: { type: 'string', enum: ['low', 'moderate', 'high'] },
    horizon: { type: 'string', enum: ['short', 'medium', 'long'] },
    summary: { type: 'string', description: 'Two sentences maximum' },
    bullCase: { type: 'array', items: insightPointSchema },
    bearCase: { type: 'array', items: insightPointSchema },
    risks: { type: 'array', items: insightPointSchema },
    positionNote: {
      type: ['string', 'null'],
      description: "How this reads against the holder's actual cost basis and position size",
    },
  },
  required: ['verdict', 'confidence', 'horizon', 'summary', 'bullCase', 'bearCase', 'risks', 'positionNote'],
  additionalProperties: false,
} as const;

const PORTFOLIO_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    diversification: {
      type: 'object',
      properties: {
        assessment: { type: 'string' },
        score: { type: 'string', enum: ['low', 'moderate', 'high'] },
        gaps: { type: 'array', items: { type: 'string' } },
      },
      required: ['assessment', 'score', 'gaps'],
      additionalProperties: false,
    },
    concentrationFlags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          allocationPercent: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['symbol', 'allocationPercent', 'note'],
        additionalProperties: false,
      },
    },
    rebalancing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          action: { type: 'string', enum: ['increase', 'decrease', 'maintain'] },
          targetPercent: { type: ['number', 'null'] },
          rationale: { type: 'string' },
        },
        required: ['symbol', 'action', 'targetPercent', 'rationale'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: insightPointSchema },
  },
  required: ['summary', 'diversification', 'concentrationFlags', 'rebalancing', 'risks'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a financial analyst assisting a private investor who tracks their own portfolio.

Ground every claim in the data provided in the user message. You have no live market access — if a figure is not in the data given to you, say so rather than estimating it.

The investor is based in Pakistan and holds Pakistan Stock Exchange (PSX) equities alongside crypto. PSX is a frontier market: it is thinner, more concentrated, and more sensitive to currency and policy shocks than developed markets. Weigh that in your risk assessment rather than reasoning as though these were US large caps.

Be specific and decision-useful. "Monitor the situation" is not analysis. Where you are uncertain, say what would resolve the uncertainty.

Never present your output as personalised financial advice or a guarantee. You are one input into the investor's own decision.`;

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw AppError.providerError(PROVIDER, 'Claude returned output that was not valid JSON.');
  }
}

export async function analyzeAsset(
  snapshot: InsightDataSnapshot & { symbol: string; assetClass: 'stock' | 'crypto'; name: string },
): Promise<AssetInsight> {
  const anthropic = getClient();
  await gate();

  const holdsIt = snapshot.userQuantity !== null && snapshot.userQuantity > 0;

  const userContent = [
    `Analyze ${snapshot.symbol}${snapshot.name && snapshot.name !== snapshot.symbol ? ` (${snapshot.name})` : ''}, a ${snapshot.assetClass === 'stock' ? 'PSX-listed equity' : 'cryptocurrency'}.`,
    '',
    '## Market data',
    `- Price: ${snapshot.price} ${snapshot.currency}`,
    `- Change: ${snapshot.changePercent.toFixed(2)}%`,
    `- Market cap: ${snapshot.marketCap !== null ? snapshot.marketCap.toLocaleString() + ' ' + snapshot.currency : 'unavailable'}`,
    `- P/E (TTM): ${snapshot.peRatio ?? 'unavailable'}`,
    `- Dividend yield: ${snapshot.dividendYield ?? 'unavailable'}`,
    '',
    holdsIt
      ? [
          '## The investor’s position',
          `- Holding: ${snapshot.userQuantity} units`,
          `- Average cost: ${snapshot.userCostBasis} ${snapshot.currency}`,
          `- Unrealised P/L: ${snapshot.userPnlPercent?.toFixed(2)}%`,
          '',
          'Address this position specifically in positionNote — someone already holding at this cost basis faces a different decision from someone considering a fresh entry.',
        ].join('\n')
      : '## Position\nThe investor does not currently hold this. Analyze it as a potential entry, and set positionNote to null.',
    '',
    snapshot.headlines.length > 0
      ? `## Recent disclosures\n${snapshot.headlines.map((h) => `- ${h}`).join('\n')}`
      : '## Recent disclosures\nNone available.',
  ].join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    // Adaptive thinking: Claude decides depth per request. On Opus 5 this is
    // also the default, but stating it makes the intent explicit.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: ASSET_INSIGHT_SCHEMA },
    },
    messages: [{ role: 'user', content: userContent }],
  });

  if (response.stop_reason === 'refusal') {
    throw AppError.providerError(PROVIDER, 'Claude declined to analyze this request.');
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw AppError.providerError(PROVIDER, 'Claude returned no text output.');
  }

  const parsed = extractJson(text.text) as Omit<
    AssetInsight,
    'symbol' | 'assetClass' | 'basedOn' | 'generatedAt' | 'model'
  >;

  return {
    ...parsed,
    symbol: snapshot.symbol,
    assetClass: snapshot.assetClass,
    basedOn: {
      price: snapshot.price,
      currency: snapshot.currency,
      changePercent: snapshot.changePercent,
      marketCap: snapshot.marketCap,
      peRatio: snapshot.peRatio,
      dividendYield: snapshot.dividendYield,
      userCostBasis: snapshot.userCostBasis,
      userQuantity: snapshot.userQuantity,
      userPnlPercent: snapshot.userPnlPercent,
      headlines: snapshot.headlines,
      asOf: snapshot.asOf,
    },
    generatedAt: Date.now(),
    model: MODEL,
  };
}

export async function reviewPortfolio(input: {
  holdings: Array<{
    symbol: string;
    assetClass: string;
    quantity: number;
    averageCost: number;
    allocationPercent: number;
    currentPrice?: number;
    pnlPercent?: number;
  }>;
  currency: string;
  totalValue: number;
}): Promise<PortfolioReview> {
  const anthropic = getClient();
  await gate();

  const rows = input.holdings
    .map(
      (h) =>
        `- ${h.symbol} (${h.assetClass}): ${h.quantity} units @ avg ${h.averageCost}, ` +
        `${h.allocationPercent.toFixed(1)}% of book` +
        (h.pnlPercent !== undefined ? `, P/L ${h.pnlPercent.toFixed(2)}%` : ''),
    )
    .join('\n');

  const userContent = [
    `Review this portfolio. Total value ${input.totalValue.toLocaleString()} ${input.currency}.`,
    '',
    '## Holdings',
    rows,
    '',
    'Assess concentration, diversification, and whether the mix suits an investor exposed to PKR. Flag any single position large enough to dominate outcomes. Where you suggest rebalancing, give a rationale tied to the numbers above.',
  ].join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    // Adaptive thinking: Claude decides depth per request. On Opus 5 this is
    // also the default, but stating it makes the intent explicit.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: PORTFOLIO_REVIEW_SCHEMA },
    },
    messages: [{ role: 'user', content: userContent }],
  });

  if (response.stop_reason === 'refusal') {
    throw AppError.providerError(PROVIDER, 'Claude declined to review this portfolio.');
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw AppError.providerError(PROVIDER, 'Claude returned no text output.');
  }

  const parsed = extractJson(text.text) as Omit<PortfolioReview, 'generatedAt' | 'model'>;
  return { ...parsed, generatedAt: Date.now(), model: MODEL };
}
