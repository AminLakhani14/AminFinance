/**
 * AI insights via any OpenAI-compatible chat-completions endpoint.
 *
 * Deliberately dependency-free: the surface used here is one POST, and going
 * through `fetch` keeps this working against a local Ollama box, LM Studio,
 * vLLM, or the OpenAI API without a vendor SDK in between.
 *
 * Two facts about small local models shape everything below:
 *
 *  1. They are slow. A 4B model on CPU generates ~1 token/second, so a full
 *     insight is minutes, not seconds — hence the very long timeout and no
 *     retries (a retry would double an already-long wait).
 *  2. Their JSON is not guaranteed. `response_format: json_schema` is honoured
 *     by recent Ollama builds but not by every server, and reasoning models
 *     wrap output in prose or `<think>` blocks. So the response is parsed
 *     defensively rather than trusted.
 *
 * Point 2 is why every reply is validated against a zod schema before it is
 * returned. Syntactically valid JSON says nothing about the *shape*: a small
 * model that ignores `response_format` will happily invent its own field names,
 * and a bare `as T` cast would pass that straight through to be cached for a
 * day and crash the client on render. Validation turns that into a plain
 * provider error, uncached, naming what came back instead.
 *
 * The schemas below must stay in sync with `shared/src/ai.ts`.
 */
import { z } from 'zod';
import type {
  AssetClass,
  AssetInsight,
  PortfolioReview,
  Opportunity,
  OpportunitySet,
  InsightDataSnapshot,
  TechnicalSnapshot,
} from '@aminfinance/shared';
import { AppError } from '../lib/errors.js';
import { acquire, retryAfterSeconds } from '../lib/rateLimit.js';
import { config } from '../config.js';

const PROVIDER = 'AI';

function requireConfigured(): void {
  if (!config.providers.ai) {
    throw AppError.notConfigured(PROVIDER, 'OPENAI_BASE_URL + OPENAI_MODEL');
  }
}

async function gate(): Promise<void> {
  try {
    await acquire('ai', 15_000);
  } catch {
    throw AppError.rateLimited(PROVIDER, retryAfterSeconds('ai'));
  }
}

/** Minimal shape of the streamed chunks we read. */
interface ChatCompletionChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      /** Ollama and some proxies split chain-of-thought into its own field. */
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  error?: { message?: string };
}

interface JsonSchemaSpec<T> {
  name: string;
  /** Sent to the endpoint as `response_format.json_schema`. Advisory only. */
  schema: Record<string, unknown>;
  /**
   * Enforced here, because the endpoint's enforcement cannot be relied on.
   * Input is `unknown` so a validator may transform — levels are normalised on
   * the way through, which makes the parsed input shape differ from the output.
   */
  output: z.ZodType<T, z.ZodTypeDef, unknown>;
}

interface StreamResult {
  content: string;
  reasoning: string;
  finishReason: string | undefined;
}

/**
 * Accumulate an SSE stream of chat-completion chunks.
 *
 * Chunks are split on newlines rather than parsed per-read because a single
 * TCP read can carry a partial line — decoding greedily would corrupt any
 * multi-byte character or JSON object straddling the boundary.
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<StreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue; // Keepalive or comment frame.
        }

        if (chunk.error?.message) {
          throw AppError.providerError(PROVIDER, `AI endpoint error: ${chunk.error.message}`);
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.delta?.reasoning) reasoning += choice.delta.reasoning;
        if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { content, reasoning, finishReason };
}

/**
 * One chat-completions call returning parsed JSON matching `spec`.
 *
 * Not routed through `lib/http.ts`: that helper retries and defaults to a 12s
 * timeout, both wrong for a call that legitimately runs for minutes and must
 * not be duplicated on a slow upstream.
 *
 * Streamed, and not optionally so. Node's fetch (undici) applies a 300s
 * headersTimeout that is not reachable from the fetch options, so a
 * non-streamed request to a model generating at ~1 token/second dies at five
 * minutes regardless of AI_TIMEOUT_MS. Streaming makes the server send headers
 * immediately and then a token at a time, so neither undici timeout is ever
 * idle long enough to fire and our own AbortController stays the real deadline.
 */
async function complete<T>(
  system: string,
  user: string,
  spec: JsonSchemaSpec<T>,
): Promise<T> {
  requireConfigured();
  await gate();

  const body: Record<string, unknown> = {
    model: config.ai.model,
    max_tokens: config.ai.maxTokens,
    stream: true,
    // Deterministic-ish: this is analysis, not creative writing, and low
    // variance also keeps the JSON well-formed more often.
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: spec.name, strict: true, schema: spec.schema },
    },
  };

  if (config.ai.reasoningEffort) {
    body.reasoning_effort = config.ai.reasoningEffort;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  let result: StreamResult;
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        // Harmless when the server ignores auth, as local Ollama does.
        ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 404) {
        throw AppError.providerError(
          PROVIDER,
          `Model "${config.ai.model}" was not found at ${config.ai.baseUrl}. Check OPENAI_MODEL.`,
        );
      }
      throw AppError.providerError(
        PROVIDER,
        `AI endpoint returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}.`,
      );
    }

    if (!res.body) {
      throw AppError.providerError(PROVIDER, 'AI endpoint returned an empty response stream.');
    }

    result = await readStream(res.body);
  } catch (err) {
    // Deliberate failures above already carry a good message.
    if (err instanceof AppError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw AppError.upstreamTimeout(
        `${PROVIDER} (${config.ai.model}) after ${Math.round(config.ai.timeoutMs / 1000)}s`,
      );
    }
    // Surface undici's cause code (UND_ERR_CONNECT_TIMEOUT, ECONNREFUSED,
    // UND_ERR_HEADERS_TIMEOUT...). Without it every network failure looks
    // identical, and "host asleep" is indistinguishable from "model too slow".
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error)?.message;
    throw AppError.providerError(
      PROVIDER,
      `Could not reach the AI endpoint at ${config.ai.baseUrl}` +
        `${detail ? ` (${detail})` : ''}. Is the host up and reachable?`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  // A reasoning model that runs out of budget mid-thought emits reasoning and
  // no content; fall back to it so the failure can be described precisely
  // rather than as "no output".
  const raw = result.content.trim() || result.reasoning.trim();

  if (!raw) {
    throw AppError.providerError(PROVIDER, `${config.ai.model} returned no output.`);
  }

  // Any `length` finish means the budget ran out mid-generation, whether or not
  // some content made it through. Previously this only fired on an empty reply,
  // so a truncated one fell through to the JSON parser and surfaced as "did not
  // return valid JSON" — which sends you looking at the model's formatting when
  // the actual problem is the token ceiling.
  if (result.finishReason === 'length') {
    throw AppError.providerError(
      PROVIDER,
      result.content.trim()
        ? `${config.ai.model} hit the ${config.ai.maxTokens}-token limit part-way through, so the ` +
          `reply was cut off mid-JSON. Raise AI_MAX_TOKENS — a ranking over many assets needs ` +
          `more room than a single insight.`
        : `${config.ai.model} hit the ${config.ai.maxTokens}-token limit before producing an answer. ` +
          `Raise AI_MAX_TOKENS, or set AI_REASONING_EFFORT=none so thinking does not consume the budget.`,
    );
  }

  return validateOutput(spec, extractJson<unknown>(raw));
}

/**
 * Check the parsed reply against the shape the client actually renders.
 *
 * The failure this exists for is a model that ignores `response_format` and
 * returns a well-formed object under names of its own invention. That is not
 * recoverable here — it needs a model that honours structured outputs — so the
 * error names the keys that came back, which is the fastest way to tell "the
 * endpoint ignored the schema" apart from "one optional field is missing".
 */
function validateOutput<T>(spec: JsonSchemaSpec<T>, value: unknown): T {
  const result = spec.output.safeParse(value);
  if (result.success) return result.data;

  const receivedKeys =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : [];
  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  throw AppError.providerError(
    PROVIDER,
    `${config.ai.model} returned JSON that does not match the ${spec.name} schema — ` +
      `the endpoint did not enforce response_format. ` +
      (receivedKeys.length > 0 ? `Top-level keys returned: ${receivedKeys.join(', ')}. ` : '') +
      `First problems: ${issues}. ` +
      `Use a model that honours structured outputs, or a larger one.`,
  );
}

/**
 * Pull a JSON object out of model output.
 *
 * Handles the three things small models do instead of returning bare JSON:
 * `<think>` preambles, ```json fences, and prose wrapped around the object.
 */
export function extractJson<T>(text: string): T {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // An unterminated <think> means the model never stopped reasoning.
  const danglingThink = cleaned.indexOf('<think>');
  if (danglingThink !== -1) cleaned = cleaned.slice(0, danglingThink).trim();

  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) cleaned = fence[1].trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to brace matching.
  }

  const candidate = firstJsonObject(cleaned);
  if (candidate) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Fall through to the shared error below.
    }
  }

  throw AppError.providerError(
    PROVIDER,
    `${config.ai.model} did not return valid JSON. First 200 characters: ${cleaned.slice(0, 200)}`,
  );
}

/**
 * First balanced `{...}` run, ignoring braces inside strings. A plain
 * indexOf/lastIndexOf pair would swallow trailing prose after the object.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
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
    chartRead: {
      type: ['string', 'null'],
      description:
        'Two to four sentences on trend, momentum and where price sits relative to its ' +
        'averages, bands and 52-week range. Null when no indicators were supplied.',
    },
    levels: {
      type: ['object', 'null'],
      properties: {
        entryZone: {
          type: ['array', 'null'],
          items: { type: 'number' },
          description: 'Exactly two numbers, low then high. Null if no entry is advisable.',
        },
        targets: {
          type: 'array',
          items: { type: 'number' },
          description: 'Take-profit levels in ascending order. Empty if none apply.',
        },
        stopLoss: {
          type: ['number', 'null'],
          description: 'Price at which the thesis is wrong, usually below support or 2x ATR',
        },
        rationale: {
          type: 'string',
          description: 'Tie each level to support, resistance, a moving average or ATR',
        },
      },
      required: ['entryZone', 'targets', 'stopLoss', 'rationale'],
      additionalProperties: false,
    },
  },
  required: [
    'verdict',
    'confidence',
    'horizon',
    'summary',
    'bullCase',
    'bearCase',
    'risks',
    'positionNote',
    'chartRead',
    'levels',
  ],
  additionalProperties: false,
} as const;

const TRADE_LEVELS_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    entryZone: { type: ['array', 'null'], items: { type: 'number' } },
    targets: { type: 'array', items: { type: 'number' } },
    stopLoss: { type: ['number', 'null'] },
    rationale: { type: 'string' },
  },
  required: ['entryZone', 'targets', 'stopLoss', 'rationale'],
  additionalProperties: false,
} as const;

const OPPORTUNITIES_SCHEMA = {
  type: 'object',
  properties: {
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          action: {
            type: 'string',
            enum: ['buy', 'accumulate', 'hold', 'reduce', 'sell'],
          },
          conviction: { type: 'string', enum: ['low', 'moderate', 'high'] },
          horizon: { type: 'string', enum: ['short', 'medium', 'long'] },
          rank: { type: 'number', description: '1 is most attractive; unique across the set' },
          rationale: { type: 'string', description: 'Two sentences at most' },
          levels: TRADE_LEVELS_SCHEMA,
        },
        required: ['symbol', 'action', 'conviction', 'horizon', 'rank', 'rationale', 'levels'],
        additionalProperties: false,
      },
    },
    marketNote: {
      type: 'string',
      description: 'What holds across the whole set — regime, correlation, currency exposure',
    },
  },
  required: ['opportunities', 'marketNote'],
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

// ---------------------------------------------------------------------------
// Runtime validators
//
// These mirror the JSON Schemas above, which the endpoint may or may not have
// applied. Unknown keys are stripped rather than rejected: a model that returns
// every required field plus an extra one of its own has still answered, and
// failing that would be stricter than the client needs.
// ---------------------------------------------------------------------------

const insightPointOutput = z.object({
  title: z.string(),
  detail: z.string(),
});

/**
 * Levels are coerced rather than trusted: a model that returns three entry
 * numbers, or targets as strings, has still done the analysis. `entryZone` is
 * normalised to an ordered pair or dropped; anything non-numeric is discarded
 * so a NaN never reaches a chart annotation.
 */
const tradeLevelsOutput = z
  .object({
    entryZone: z.array(z.coerce.number()).nullable(),
    targets: z.array(z.coerce.number()),
    stopLoss: z.coerce.number().nullable(),
    rationale: z.string(),
  })
  .transform((levels) => {
    const finite = (n: number): boolean => Number.isFinite(n);
    const zone = (levels.entryZone ?? []).filter(finite).sort((a, b) => a - b);
    return {
      entryZone: zone.length >= 2 ? ([zone[0], zone[zone.length - 1]] as [number, number]) : null,
      targets: levels.targets.filter(finite).sort((a, b) => a - b),
      stopLoss: levels.stopLoss !== null && finite(levels.stopLoss) ? levels.stopLoss : null,
      rationale: levels.rationale,
    };
  });

const ASSET_INSIGHT_OUTPUT = z.object({
  verdict: z.enum(['buy', 'hold', 'reduce', 'sell']),
  confidence: z.enum(['low', 'moderate', 'high']),
  horizon: z.enum(['short', 'medium', 'long']),
  summary: z.string(),
  bullCase: z.array(insightPointOutput),
  bearCase: z.array(insightPointOutput),
  risks: z.array(insightPointOutput),
  positionNote: z.string().nullable(),
  chartRead: z.string().nullable(),
  levels: tradeLevelsOutput.nullable(),
});

const OPPORTUNITIES_OUTPUT = z.object({
  opportunities: z.array(
    z.object({
      symbol: z.string(),
      action: z.enum(['buy', 'accumulate', 'hold', 'reduce', 'sell']),
      conviction: z.enum(['low', 'moderate', 'high']),
      horizon: z.enum(['short', 'medium', 'long']),
      rank: z.coerce.number(),
      rationale: z.string(),
      levels: tradeLevelsOutput.nullable(),
    }),
  ),
  marketNote: z.string(),
});

const PORTFOLIO_REVIEW_OUTPUT = z.object({
  summary: z.string(),
  diversification: z.object({
    assessment: z.string(),
    score: z.enum(['low', 'moderate', 'high']),
    gaps: z.array(z.string()),
  }),
  concentrationFlags: z.array(
    z.object({
      symbol: z.string(),
      allocationPercent: z.number(),
      note: z.string(),
    }),
  ),
  rebalancing: z.array(
    z.object({
      symbol: z.string(),
      action: z.enum(['increase', 'decrease', 'maintain']),
      targetPercent: z.number().nullable(),
      rationale: z.string(),
    }),
  ),
  risks: z.array(insightPointOutput),
});

const SYSTEM_PROMPT = `You are a financial analyst assisting a private investor who tracks their own portfolio.

Ground every claim in the data provided in the user message. You have no live market access — if a figure is not in the data given to you, say so rather than estimating it.

The investor is based in Pakistan and holds Pakistan Stock Exchange (PSX) equities alongside crypto. PSX is a frontier market: it is thinner, more concentrated, and more sensitive to currency and policy shocks than developed markets. Weigh that in your risk assessment rather than reasoning as though these were US large caps.

Be specific and decision-useful. "Monitor the situation" is not analysis. Where you are uncertain, say what would resolve the uncertainty.

When indicator readings are supplied, read them as evidence about the current state of the chart — trend, momentum, where price sits against its averages, bands and 52-week range — not as a forecast. Indicators describe what has happened. They do not predict what happens next, and you must not imply otherwise.

Rules for the levels you propose:
- Anchor every level to something in the data: a swing support or resistance, a moving average, a band edge, or a multiple of ATR. A round number pulled from nowhere is worse than no level.
- A stop-loss belongs where the thesis is disproven, not at an arbitrary percentage. Below the nearest support, or roughly two ATR from entry, is usually defensible.
- If price already sits above a sensible entry, say so and return a null entryZone rather than inventing a chase.
- Set levels to null entirely when fewer than 50 bars are available, or when the readings conflict without resolution. Declining to give a number is a legitimate answer.

Never present your output as personalised financial advice or a guarantee. You are one input into the investor's own decision. Do not promise returns, and do not describe any setup as low-risk or certain.

Respond with a single JSON object matching the requested schema. No prose, no markdown fences, no commentary outside the JSON.`;

/** How each class is described to the model, so the prompt reads naturally. */
const ASSET_DESCRIPTION: Record<AssetClass, string> = {
  stock: 'PSX-listed equity',
  crypto: 'cryptocurrency',
  commodity: 'precious metal, quoted per troy ounce on the spot market',
};

/** Round for the prompt: six significant figures is past any real precision. */
function num(value: number | null, digits = 2): string {
  return value === null ? 'unavailable' : value.toFixed(digits);
}

/**
 * Render the indicator block.
 *
 * Values are labelled with their period and unit, and missing ones are printed
 * as "unavailable" rather than omitted — a model that sees no `sma200` line at
 * all tends to assume one exists and invent it, whereas an explicit gap is
 * reliably reported as a gap.
 */
function formatTechnicals(technicals: TechnicalSnapshot | null, currency: string): string {
  if (!technicals) {
    return '## Chart\nNo indicator data available — too few candles. Set chartRead and levels to null.';
  }

  const t = technicals;
  const lines = [
    '## Chart (daily candles)',
    `- Bars available: ${t.bars}`,
    `- Trend: ${t.trend}`,
    `- SMA 20 / 50 / 200: ${num(t.sma20)} / ${num(t.sma50)} / ${num(t.sma200)} ${currency}`,
    `- RSI(14): ${num(t.rsi14, 1)}`,
    t.macd
      ? `- MACD(12,26,9): line ${num(t.macd.line, 4)}, signal ${num(t.macd.signal, 4)}, histogram ${num(t.macd.histogram, 4)}`
      : '- MACD(12,26,9): unavailable',
    t.bollinger
      ? `- Bollinger(20,2): lower ${num(t.bollinger.lower)}, mid ${num(t.bollinger.middle)}, upper ${num(t.bollinger.upper)}, %B ${num(t.bollinger.percentB, 2)}`
      : '- Bollinger(20,2): unavailable',
    `- ATR(14): ${num(t.atr14)} ${currency}${t.atrPercent !== null ? ` (${num(t.atrPercent, 1)}% of price)` : ''}`,
    `- 52-week range: ${num(t.low52w)} to ${num(t.high52w)} ${currency}, price sits at ${t.rangePosition !== null ? `${(t.rangePosition * 100).toFixed(0)}%` : 'unavailable'} of it`,
    `- Nearest swing support / resistance: ${num(t.support)} / ${num(t.resistance)} ${currency}`,
    `- Change over 7 / 30 / 90 sessions: ${num(t.changePercent7d, 1)}% / ${num(t.changePercent30d, 1)}% / ${num(t.changePercent90d, 1)}%`,
  ];

  if (t.bars < 50) {
    lines.push(
      '',
      `Only ${t.bars} bars exist, so longer averages are absent and the readings are thin. Return null for levels.`,
    );
  }

  return lines.join('\n');
}

export async function analyzeAsset(
  snapshot: InsightDataSnapshot & { symbol: string; assetClass: AssetClass; name: string },
): Promise<AssetInsight> {
  const holdsIt = snapshot.userQuantity !== null && snapshot.userQuantity > 0;

  const userContent = [
    `Analyze ${snapshot.symbol}${snapshot.name && snapshot.name !== snapshot.symbol ? ` (${snapshot.name})` : ''}, a ${ASSET_DESCRIPTION[snapshot.assetClass]}.`,
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
    '',
    formatTechnicals(snapshot.technicals, snapshot.currency),
  ].join('\n');

  const parsed = await complete<
    Omit<AssetInsight, 'symbol' | 'assetClass' | 'basedOn' | 'generatedAt' | 'model'>
  >(SYSTEM_PROMPT, userContent, {
    name: 'asset_insight',
    schema: ASSET_INSIGHT_SCHEMA,
    output: ASSET_INSIGHT_OUTPUT,
  });

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
      technicals: snapshot.technicals,
      asOf: snapshot.asOf,
    },
    generatedAt: Date.now(),
    model: config.ai.model,
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

  const parsed = await complete<Omit<PortfolioReview, 'generatedAt' | 'model'>>(
    SYSTEM_PROMPT,
    userContent,
    {
      name: 'portfolio_review',
      schema: PORTFOLIO_REVIEW_SCHEMA,
      output: PORTFOLIO_REVIEW_OUTPUT,
    },
  );

  return { ...parsed, generatedAt: Date.now(), model: config.ai.model };
}

/** One asset as presented to the ranking prompt. */
export interface OpportunityInput {
  symbol: string;
  assetClass: AssetClass;
  price: number;
  currency: string;
  changePercent: number;
  held: boolean;
  quantity: number | null;
  averageCost: number | null;
  pnlPercent: number | null;
  allocationPercent: number | null;
  technicals: TechnicalSnapshot | null;
  /** PSX issuers only — crypto and spot metal have no issuer to report. */
  fundamentals: {
    name: string | null;
    marketCap: number | null;
    peRatio: number | null;
    epsTtm: number | null;
    dividendYield: number | null;
    sector: string | null;
  } | null;
  /** Daily closes for the client's chart; not shown to the model. */
  series: number[];
}

/**
 * Issuer fundamentals for the ranking prompt.
 *
 * Absent for crypto and metal by nature, and often partly absent for PSX too —
 * the data portal does not publish every field for every issuer. Missing values
 * are printed as "unavailable" rather than omitted, for the same reason as in
 * `formatTechnicals`: a model that sees no P/E line assumes one exists and
 * invents it, whereas an explicit gap is reported as a gap.
 */
function formatFundamentals(asset: OpportunityInput): string {
  if (asset.assetClass !== 'stock') {
    return `- Fundamentals: none — ${ASSET_DESCRIPTION[asset.assetClass]} has no issuer accounts. Judge it on price, trend and portfolio role alone.`;
  }
  if (!asset.fundamentals) {
    return '- Fundamentals: unavailable for this issuer.';
  }

  const f = asset.fundamentals;
  const money = (v: number | null): string =>
    v === null ? 'unavailable' : `${v.toLocaleString()} ${asset.currency}`;

  return [
    `- Sector: ${f.sector ?? 'unavailable'}`,
    `- Market cap: ${money(f.marketCap)}`,
    `- P/E (TTM): ${f.peRatio ?? 'unavailable'}`,
    `- EPS (TTM): ${f.epsTtm ?? 'unavailable'}`,
    `- Dividend yield: ${f.dividendYield !== null ? `${f.dividendYield}%` : 'unavailable'}`,
  ].join('\n');
}

/**
 * Rank a set of assets against each other in a single call.
 *
 * One call rather than N: ranking is inherently comparative, and asking about
 * each asset separately would produce N independent verdicts that cannot be
 * ordered against one another — every one of them "moderate conviction buy",
 * with no way to tell which deserves the next rupee. It is also N times the
 * latency and quota.
 *
 * Prices are pre-converted by the caller into one display currency so the model
 * never compares a PKR equity against a dollar coin as if the numbers were
 * commensurable.
 */
export async function rankOpportunities(input: {
  assets: OpportunityInput[];
  currency: string;
}): Promise<Omit<OpportunitySet, 'skipped'>> {
  const blocks = input.assets.map((asset) => {
    const lines = [
      `### ${asset.symbol} (${ASSET_DESCRIPTION[asset.assetClass]})`,
      `- Price: ${asset.price} ${asset.currency} (${asset.changePercent >= 0 ? '+' : ''}${asset.changePercent.toFixed(2)}% on the session)`,
      asset.held
        ? `- Held: ${asset.quantity} units at average cost ${asset.averageCost} ${asset.currency}, ` +
          `unrealised P/L ${asset.pnlPercent !== null ? `${asset.pnlPercent.toFixed(2)}%` : 'unknown'}, ` +
          `${asset.allocationPercent !== null ? `${asset.allocationPercent.toFixed(1)}% of the book` : 'weight unknown'}`
        : '- Not currently held. Judge it as a fresh entry.',
      formatFundamentals(asset),
      formatTechnicals(asset.technicals, asset.currency),
    ];
    return lines.join('\n');
  });

  const userContent = [
    `Rank these ${input.assets.length} assets against each other for an investor whose book is reported in ${input.currency}.`,
    '',
    'Assign every asset a unique rank from 1 upward, where 1 is where the next unit of capital is best deployed. Rank all of them — do not omit any, and do not return two assets with the same rank.',
    '',
    'Use `buy` only for something not currently held, `accumulate` to add to an existing position, and `reduce` or `sell` to take capital out. `hold` means leave it exactly as it is.',
    '',
    blocks.join('\n\n'),
  ].join('\n');

  // `assetClass` and `held` are facts the server already knows, so they are
  // filled in below rather than asked for — one less field the model can get
  // wrong, and one less way a hallucinated symbol reaches the client.
  const parsed = await complete<{
    opportunities: Array<
      Omit<Opportunity, 'assetClass' | 'held' | 'currency' | 'price' | 'series'>
    >;
    marketNote: string;
  }>(SYSTEM_PROMPT, userContent, {
    name: 'opportunities',
    schema: OPPORTUNITIES_SCHEMA,
    output: OPPORTUNITIES_OUTPUT,
  });

  // The model is told ranks are unique, but a duplicate or a gap must not
  // reorder the list arbitrarily at render time. Sort by the rank given, then
  // renumber so the output is always a clean 1..n.
  const held = new Map(input.assets.map((a) => [a.symbol.toUpperCase(), a]));
  const opportunities = parsed.opportunities
    .filter((o) => held.has(o.symbol.toUpperCase()))
    .sort((a, b) => a.rank - b.rank)
    .map((o, i) => {
      const asset = held.get(o.symbol.toUpperCase()) as OpportunityInput;
      return {
        ...o,
        symbol: asset.symbol,
        assetClass: asset.assetClass,
        currency: asset.currency,
        price: asset.price,
        series: asset.series,
        held: asset.held,
        rank: i + 1,
      };
    });

  return { opportunities, marketNote: parsed.marketNote, generatedAt: Date.now(), model: config.ai.model };
}
