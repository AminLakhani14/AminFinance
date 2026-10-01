/**
 * Outbound HTTP with timeouts and bounded retries.
 *
 * Every upstream call goes through here so that a hung provider can never hold
 * a request open indefinitely — Node's fetch has no default timeout, so
 * without an explicit AbortSignal a stalled TCP connection blocks until the OS
 * gives up, which can be minutes.
 */
import { AppError } from './errors.js';

/** Identify ourselves honestly. PSX DPS rejects some default agents. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; AminFinance/0.1; personal portfolio tracker)';

export interface FetchOptions {
  timeoutMs?: number;
  /** Retries for transient failures (5xx, network). 429 is never retried here. */
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Provider label used in error messages. */
  provider: string;
  /**
   * Hand back a 4xx response instead of throwing, for callers that read the
   * upstream's own error body. A provider that explains *why* it refused —
   * Binance's `-2015 … request ip: 1.2.3.4` — is worth more than "HTTP 401".
   * 429 still throws as rate-limited.
   */
  returnClientErrors?: boolean;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 522, 524]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function once(
  url: string,
  { timeoutMs = 12_000, headers = {}, method = 'GET', body, provider }: FetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw AppError.upstreamTimeout(provider);
    }
    throw AppError.providerError(provider, `Network error contacting ${provider}.`, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with retry. Returns the Response; callers decode. */
export async function httpGet(url: string, options: FetchOptions): Promise<Response> {
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Only the transport is retried here: `once` throws for timeouts and
    // network failures, nothing else.
    let res: Response;
    try {
      res = await once(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw err;
    }

    if (res.ok) return res;

    // Upstream rate limit — surface immediately with its own retry hint
    // rather than burning our retry budget making it worse.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 60);
      throw AppError.rateLimited(options.provider, Number.isFinite(retryAfter) ? retryAfter : 60);
    }

    if (options.returnClientErrors && res.status >= 400 && res.status < 500) return res;

    if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
      await sleep(300 * 2 ** attempt);
      continue;
    }

    // Any other status is the upstream's answer, not a blip. Retrying a 404
    // or 403 used to happen here — the status error was caught below and
    // mistaken for a network failure — which cost two backoffs (~1s) on every
    // call to a moved or forbidden endpoint and returned the same answer.
    throw AppError.providerError(options.provider, `${options.provider} returned HTTP ${res.status}.`);
  }

  throw lastError instanceof Error
    ? lastError
    : AppError.providerError(options.provider, 'Unknown upstream failure.');
}

export async function httpGetJson<T>(url: string, options: FetchOptions): Promise<T> {
  const res = await httpGet(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw AppError.providerError(options.provider, `${options.provider} returned malformed JSON.`, err);
  }
}

export async function httpGetText(url: string, options: FetchOptions): Promise<string> {
  const res = await httpGet(url, options);
  return res.text();
}
