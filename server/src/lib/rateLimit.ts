/**
 * Per-provider token buckets.
 *
 * PSX DPS publishes no rate limit. That is not permission to hammer it — an
 * undocumented limit is still a limit, and getting our IP blocked would take
 * the whole app down. Every provider gets a conservative budget, and requests
 * queue rather than fail when it is exhausted.
 */

interface Bucket {
  capacity: number;
  tokens: number;
  /** Tokens added per second. */
  refillRate: number;
  lastRefill: number;
  queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
}

const buckets = new Map<string, Bucket>();

/**
 * Budgets are deliberately below each provider's published ceiling (where one
 * exists) so a burst never trips the real limit.
 */
const BUDGETS: Record<string, { capacity: number; perSecond: number }> = {
  // No published quota — self-imposed and deliberately gentle.
  psx: { capacity: 10, perSecond: 2 },
  // Binance public: ~1200 weight/min. Well under.
  binance: { capacity: 20, perSecond: 5 },
  binanceSigned: { capacity: 5, perSecond: 1 },
  coingecko: { capacity: 5, perSecond: 0.4 },
  fx: { capacity: 5, perSecond: 0.2 },
  finnhub: { capacity: 10, perSecond: 0.8 },
  // 25/day. One token every ~an hour, tiny burst allowance.
  alphaVantage: { capacity: 3, perSecond: 0.0003 },
  twelveData: { capacity: 5, perSecond: 0.15 },
  anthropic: { capacity: 3, perSecond: 0.1 },
};

function getBucket(provider: string): Bucket {
  let bucket = buckets.get(provider);
  if (!bucket) {
    const budget = BUDGETS[provider] ?? { capacity: 5, perSecond: 1 };
    bucket = {
      capacity: budget.capacity,
      tokens: budget.capacity,
      refillRate: budget.perSecond,
      lastRefill: Date.now(),
      queue: [],
    };
    buckets.set(provider, bucket);
  }
  return bucket;
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  if (elapsedSeconds <= 0) return;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillRate);
  bucket.lastRefill = now;
}

function drainQueue(bucket: Bucket): void {
  refill(bucket);
  while (bucket.queue.length > 0 && bucket.tokens >= 1) {
    const waiter = bucket.queue.shift();
    if (!waiter) break;
    clearTimeout(waiter.timer);
    bucket.tokens -= 1;
    waiter.resolve();
  }
}

/**
 * Acquire one token, waiting up to `maxWaitMs`.
 *
 * Rejects rather than waiting forever — a caller stuck behind an exhausted
 * bucket should fall back to cached data, not hold an HTTP request open.
 */
export function acquire(provider: string, maxWaitMs = 5_000): Promise<void> {
  const bucket = getBucket(provider);
  refill(bucket);

  if (bucket.tokens >= 1 && bucket.queue.length === 0) {
    bucket.tokens -= 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = bucket.queue.findIndex((w) => w.timer === timer);
      if (index >= 0) bucket.queue.splice(index, 1);
      reject(new Error(`rate_limit_wait_exceeded:${provider}`));
    }, maxWaitMs);
    timer.unref?.();
    bucket.queue.push({ resolve, reject, timer });
  });
}

// One shared ticker drains every bucket; cheaper than a timer per bucket.
const ticker = setInterval(() => {
  for (const bucket of buckets.values()) {
    if (bucket.queue.length > 0) drainQueue(bucket);
  }
}, 200);
ticker.unref?.();

/** Seconds until at least one token is available. Used for Retry-After. */
export function retryAfterSeconds(provider: string): number {
  const bucket = getBucket(provider);
  refill(bucket);
  if (bucket.tokens >= 1) return 0;
  return Math.max(1, Math.ceil((1 - bucket.tokens) / bucket.refillRate));
}

export function snapshot(): Record<string, { tokens: number; queued: number }> {
  const out: Record<string, { tokens: number; queued: number }> = {};
  for (const [name, bucket] of buckets) {
    refill(bucket);
    out[name] = { tokens: Math.floor(bucket.tokens), queued: bucket.queue.length };
  }
  return out;
}
