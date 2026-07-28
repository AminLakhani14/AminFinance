/**
 * Liveness + capability probe.
 *
 * Unauthenticated (see plugins/auth.ts), so it returns booleans describing
 * which providers are configured — never key values, and never enough to
 * infer one.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

export interface HealthResponse {
  status: 'ok';
  env: string;
  uptimeSeconds: number;
  timestamp: number;
  /** Whether /api/* requires the shared-secret header. */
  authRequired: boolean;
  /** Per-provider configuration state, for the client's Settings page. */
  providers: Record<string, boolean>;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: Date.now(),
    authRequired: config.authRequired,
    providers: { ...config.providers },
  }));
}
