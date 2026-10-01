/**
 * AminFinance server — a thin proxy holding API keys, syncing Binance, and
 * sharing one cache across every client session. No database, no auth beyond
 * a shared secret; your portfolio lives in the browser.
 *
 * See PROJECT_PLAN.md §4 for the design.
 */
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { ApiError } from '@aminfinance/shared';
import { config, describeCapabilities } from './config.js';
import { AppError, isAppError } from './lib/errors.js';
import websocket from '@fastify/websocket';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { marketRoutes } from './routes/market.js';
import { binanceRoutes } from './routes/binance.js';
import { aiRoutes } from './routes/ai.js';
import { tradingRoutes } from './routes/trading.js';
import { newsRoutes } from './routes/news.js';
import { priceStreamRoutes } from './ws/prices.js';

async function buildServer() {
  const app = Fastify({
    logger: config.isDev
      ? {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : { level: 'info' },
    // Trust no proxy headers by default — this server is meant to sit on
    // loopback. Enable explicitly if it is ever placed behind a real proxy.
    trustProxy: false,
  });

  await app.register(helmet, {
    // No HTML is served from here, so CSP has nothing to protect and only
    // creates confusing failures for JSON clients.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: false,
    // The client sends the shared secret on every /api/* call.
    allowedHeaders: ['content-type', 'x-aminfinance-key'],
    // Cache freshness metadata is read by the client's baseQuery; without
    // exposeHeaders the browser hides these from JS entirely.
    exposedHeaders: ['x-cache', 'x-data-age', 'x-stale'],
  });

  // Coarse backstop against a runaway client loop. Per-provider budgets are
  // enforced separately by the token buckets in Phase 2, and the AI routes
  // get their own tighter limit in Phase 5 since those calls cost money.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => {
      const body: ApiError = {
        error: {
          code: 'rate_limited',
          message: `Too many requests. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
          retryAfter: Math.ceil(ctx.ttl / 1000),
        },
      };
      return body;
    },
  });

  registerAuth(app);

  // Single error envelope for every failure path, so the client only ever
  // parses one shape. See shared/src/api.ts → ApiError.
  app.setErrorHandler((err, request, reply) => {
    if (isAppError(err)) {
      // Expected, actionable failures — log at warn without a stack.
      request.log.warn(
        { code: err.code, provider: err.provider, url: request.url },
        err.message,
      );
      const body: ApiError = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.provider !== undefined ? { provider: err.provider } : {}),
          ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
        },
      };
      if (err.retryAfter !== undefined) reply.header('retry-after', String(err.retryAfter));
      return reply.status(err.statusCode).send(body);
    }

    // Narrowing on `isAppError` leaves the else branch untyped, so restate the
    // Fastify shape rather than reading properties off `unknown`.
    const fastifyError = err as FastifyError;

    // Fastify's own schema-validation errors carry a 4xx statusCode.
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      const body: ApiError = {
        error: { code: 'bad_request', message: fastifyError.message },
      };
      return reply.status(fastifyError.statusCode).send(body);
    }

    // Anything reaching here is a bug. Log the stack; tell the client nothing
    // that could aid an attacker.
    request.log.error({ err, url: request.url }, 'Unhandled server error');
    const body: ApiError = {
      error: { code: 'internal', message: 'An unexpected server error occurred.' },
    };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = {
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
    };
    return reply.status(404).send(body);
  });

  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(marketRoutes);
  await app.register(binanceRoutes);
  await app.register(priceStreamRoutes);
  await app.register(aiRoutes);
  await app.register(tradingRoutes);
  await app.register(newsRoutes);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }

  app.log.info(`\nProvider capabilities:\n${describeCapabilities()}\n`);

  if (!config.authRequired) {
    app.log.warn('Running without AUTH_SECRET (loopback only).');
  }

  // Drain in-flight requests before exiting so a restart never truncates a
  // response mid-stream.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down.`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// A rejected promise that escapes a route would otherwise take the process
// down with no context.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

void main();

export { buildServer, AppError };
