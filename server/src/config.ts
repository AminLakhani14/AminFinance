/**
 * Environment loading and validation.
 *
 * Fails fast on genuine misconfiguration (bad port, unsafe auth setup) but
 * treats missing provider keys as a degraded capability rather than a fatal
 * error — you should be able to boot with only a Finnhub key and have the
 * stock routes work while the rest report `provider_not_configured`.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('127.0.0.1'),
  /**
   * Browser origins allowed to call this server, comma-separated: the local
   * dev client and the deployed Netlify site. Set CORS_ORIGIN to replace the
   * list — for a different frontend address, for instance.
   */
  CORS_ORIGIN: z.string().default('http://localhost:5173,https://aminfinance.netlify.app'),
  AUTH_SECRET: z.string().default(''),

  FINNHUB_API_KEY: z.string().default(''),
  ALPHAVANTAGE_API_KEY: z.string().default(''),
  COINGECKO_API_KEY: z.string().default(''),
  TWELVEDATA_API_KEY: z.string().default(''),
  /**
   * State Bank of Pakistan — easydata.sbp.org.pk. Optional: without it the
   * Economy tab serves annual World Bank series, which is correct but coarse.
   * With it, SBP's weekly reserves and policy rate can replace them.
   */
  SBP_API_KEY: z.string().default(''),
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),

  // AI insights speak the OpenAI chat-completions dialect, so any compatible
  // server works: a local Ollama/LM Studio box, a self-hosted vLLM, or the
  // OpenAI API itself. Only the base URL and model name change.
  OPENAI_BASE_URL: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),
  /**
   * Local models on modest hardware generate at a few tokens/second, so an
   * insight can legitimately take many minutes. Far longer than the 12s used
   * for market-data providers.
   */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(4_000),
  /**
   * Sent as `reasoning_effort`. On a reasoning model (Qwen3.5, gpt-oss) the
   * chain of thought is billed in generated tokens, which on a slow local box
   * costs minutes and can consume the entire budget before any JSON is
   * emitted — so "none" is the default. Blank omits the field for servers that
   * reject it.
   */
  AI_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', '']).default('none'),
  /**
   * AI calls allowed to start together. The AI page asks for three rankings
   * at once (stocks, coins, metals), so a limit of one turned two of them into
   * "rate limit reached" errors. Three suits an endpoint that runs requests in
   * parallel, as hosted APIs and most gateways do; set 1 for a local model
   * that can only serve one request at a time.
   */
  AI_MAX_PARALLEL: z.coerce.number().int().min(1).max(10).default(3),

  /**
   * Fallback AI: Google Gemini, through its OpenAI-compatible endpoint. Used
   * when the OPENAI_* endpoint above is unset, unreachable or failing — on a
   * hosted server that one often points at a gateway on someone's own PC,
   * which the host cannot reach at all.
   *
   * Comma-separated keys, used in order: when one runs out of quota or is
   * rejected, the next takes over.
   */
  GEMINI_API_KEYS: z.string().default(''),
  /**
   * Models to try, in order. A list rather than one name because Gemini
   * models come and go — older ones are withdrawn for new keys, and a busy one
   * answers 503 at peak times — so the next is tried when one is unavailable.
   * The `-latest` aliases follow Google's newest release of each tier.
   */
  GEMINI_MODELS: z.string().default('gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid server environment:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

/** Addresses that are safe to run without a shared secret. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const isLoopback = LOOPBACK.has(env.HOST);

/**
 * Refuse to expose a key-holding proxy on a public interface without auth.
 * This is the single most damaging misconfiguration available here, so it is
 * a hard stop rather than a warning.
 */
if (!env.AUTH_SECRET && !isLoopback) {
  console.error(
    `\nRefusing to start: HOST is "${env.HOST}" (not loopback) and AUTH_SECRET is empty.\n` +
      `This server holds live Binance credentials and can reach your AI endpoint.\n` +
      `Binding it to a reachable interface without a shared secret lets anyone read\n` +
      `your balances and run jobs on your AI host.\n\n` +
      `Fix: set AUTH_SECRET in server/.env, or set HOST=127.0.0.1.\n` +
      `Generate a secret with:  node -e "console.log(crypto.randomUUID())"\n`,
  );
  process.exit(1);
}

/**
 * Which upstreams have credentials. Routes consult this to return a clear
 * `provider_not_configured` error instead of a confusing 401 from upstream.
 */
export const providers = {
  finnhub: Boolean(env.FINNHUB_API_KEY),
  alphaVantage: Boolean(env.ALPHAVANTAGE_API_KEY),
  coingecko: Boolean(env.COINGECKO_API_KEY),
  twelveData: Boolean(env.TWELVEDATA_API_KEY),
  /**
   * Gates the higher-frequency reserves path only. Economic data still works
   * without it — World Bank needs no key — so this is a quality upgrade, not a
   * capability switch.
   */
  sbp: Boolean(env.SBP_API_KEY),
  /** Public Binance endpoints need no key; this gates the signed ones only. */
  binanceAccount: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET),
  /**
   * No API key requirement for the main endpoint: a local Ollama server
   * accepts any bearer token (or none), so demanding one here would disable a
   * working setup. Either the main endpoint or the Gemini fallback is enough.
   */
  ai: Boolean((env.OPENAI_BASE_URL && env.OPENAI_MODEL) || env.GEMINI_API_KEYS.trim()),
} as const;

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export type ProviderName = keyof typeof providers;

export const config = {
  env: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  port: env.PORT,
  host: env.HOST,
  isLoopback,
  corsOrigins: env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  authSecret: env.AUTH_SECRET,
  /** True when requests must carry the shared secret. */
  authRequired: Boolean(env.AUTH_SECRET),
  keys: {
    finnhub: env.FINNHUB_API_KEY,
    alphaVantage: env.ALPHAVANTAGE_API_KEY,
    coingecko: env.COINGECKO_API_KEY,
    twelveData: env.TWELVEDATA_API_KEY,
    sbp: env.SBP_API_KEY,
    binanceKey: env.BINANCE_API_KEY,
    binanceSecret: env.BINANCE_API_SECRET,
  },
  ai: {
    /** Normalised without a trailing slash; paths are appended with a leading one. */
    baseUrl: env.OPENAI_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxTokens: env.AI_MAX_TOKENS,
    reasoningEffort: env.AI_REASONING_EFFORT,
    maxParallel: env.AI_MAX_PARALLEL,
    /** Whether the main OPENAI_* endpoint is set at all. */
    primaryConfigured: Boolean(env.OPENAI_BASE_URL && env.OPENAI_MODEL),
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keys: splitList(env.GEMINI_API_KEYS),
      models: splitList(env.GEMINI_MODELS),
    },
  },
  providers,
} as const;

/** Human-readable capability report, logged once at boot. */
export function describeCapabilities(): string {
  const rows: Array<[string, boolean, string]> = [
    ['Binance public (prices, candles)', true, 'no key required'],
    ['Binance account sync', providers.binanceAccount, 'BINANCE_API_KEY + SECRET'],
    ['Finnhub (stock quotes, news)', providers.finnhub, 'FINNHUB_API_KEY'],
    ['Alpha Vantage (dividends)', providers.alphaVantage, 'ALPHAVANTAGE_API_KEY'],
    ['CoinGecko (coin metadata)', providers.coingecko, 'COINGECKO_API_KEY'],
    [
      `Metals (spot, charts)${providers.twelveData ? ' — Twelve Data' : ' — keyless fallback'}`,
      true,
      'TWELVEDATA_API_KEY for higher quality',
    ],
    [
      `Economy (Pakistan macro)${providers.sbp ? ' — SBP weekly' : ' — World Bank annual'}`,
      true,
      'SBP_API_KEY for weekly reserves',
    ],
    [
      `AI insights${
        providers.ai
          ? ` (${[
              config.ai.primaryConfigured ? config.ai.model : null,
              config.ai.gemini.keys.length > 0
                ? `Gemini fallback, ${config.ai.gemini.keys.length} key${config.ai.gemini.keys.length === 1 ? '' : 's'}`
                : null,
            ]
              .filter(Boolean)
              .join(' + ')})`
          : ''
      }`,
      providers.ai,
      'OPENAI_BASE_URL + OPENAI_MODEL, or GEMINI_API_KEYS',
    ],
  ];

  return rows
    .map(([name, ok, hint]) => `  ${ok ? '[on ]' : '[off]'} ${name}${ok ? '' : `  — set ${hint}`}`)
    .join('\n');
}
