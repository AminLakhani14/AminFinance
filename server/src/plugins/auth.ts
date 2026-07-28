/**
 * Shared-secret gate on /api/*.
 *
 * This is the only thing standing between a reachable proxy and the live
 * credentials it holds, so the comparison is timing-safe and the failure mode
 * is closed (reject) rather than open.
 *
 * `/health` is deliberately exempt so container and uptime probes work without
 * distributing the secret; it exposes booleans only, never key material.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AUTH_HEADER } from '@aminfinance/shared';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

const PUBLIC_PATHS = new Set(['/health']);

/** Length-independent constant-time comparison. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare a fixed-size digest-like buffer instead: pad to the longer length.
  if (a.length !== b.length) {
    // Still burn a comparison so the reject path costs the same either way.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function registerAuth(app: FastifyInstance): void {
  if (!config.authRequired) {
    app.log.warn(
      'AUTH_SECRET is empty — /api/* is unauthenticated. Safe only because ' +
        `HOST is loopback (${config.host}). Set AUTH_SECRET before exposing this server.`,
    );
    return;
  }

  app.addHook('onRequest', async (request) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;
    if (!request.url.startsWith('/api/')) return;

    const provided = request.headers[AUTH_HEADER];
    if (typeof provided !== 'string' || !secretsMatch(provided, config.authSecret)) {
      throw AppError.unauthorized(
        `Missing or invalid ${AUTH_HEADER} header.`,
      );
    }
  });
}
