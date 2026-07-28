/**
 * Response types for endpoints that are server-local rather than part of the
 * shared domain model. Anything describing market or portfolio data belongs in
 * `@aminfinance/shared` so both sides compile against one definition.
 */

/** Mirrors `server/src/routes/health.ts` → HealthResponse. */
export interface HealthResponse {
  status: 'ok';
  env: string;
  uptimeSeconds: number;
  timestamp: number;
  authRequired: boolean;
  /** Which upstreams have credentials configured. Booleans only. */
  providers: Record<string, boolean>;
}
