/**
 * Typed application errors.
 *
 * Every route throws `AppError` rather than returning ad-hoc shapes, so the
 * global error handler in `index.ts` can emit the single `ApiError` envelope
 * the client's baseQuery expects.
 */
import type { ApiErrorCode } from '@aminfinance/shared';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  provider_not_configured: 503,
  provider_error: 502,
  upstream_timeout: 504,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly provider: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { provider?: string; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.provider = options.provider;
    this.retryAfter = options.retryAfter;
  }

  static badRequest(message: string): AppError {
    return new AppError('bad_request', message);
  }

  static unauthorized(message = 'Missing or invalid API key.'): AppError {
    return new AppError('unauthorized', message);
  }

  static notFound(message: string): AppError {
    return new AppError('not_found', message);
  }

  static rateLimited(provider: string, retryAfter: number): AppError {
    return new AppError(
      'rate_limited',
      `Rate limit reached for ${provider}. Retry in ${retryAfter}s.`,
      { provider, retryAfter },
    );
  }

  /**
   * The upstream key for this route is not set in server/.env. Distinct from
   * `unauthorized`, which is about the client's shared secret.
   */
  static notConfigured(provider: string, envVar: string): AppError {
    return new AppError(
      'provider_not_configured',
      `${provider} is not configured. Set ${envVar} in server/.env and restart.`,
      { provider },
    );
  }

  static providerError(provider: string, message: string, cause?: unknown): AppError {
    return new AppError('provider_error', message, { provider, cause });
  }

  static upstreamTimeout(provider: string): AppError {
    return new AppError('upstream_timeout', `${provider} did not respond in time.`, {
      provider,
    });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
