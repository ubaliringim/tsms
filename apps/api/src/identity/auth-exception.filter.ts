import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { HttpServer } from '@nestjs/common';
import { AuthError, type AuthErrorCode } from './auth.service.js';
import type { SecurityLog } from './security-log.js';
import { requestIdOf } from './security-request-context.js';

/**
 * Minimal structural view of the platform response.
 *
 * `apps/api` deliberately does not depend on `express` or `@types/express`, so only the two methods
 * actually used here are declared. The Express response satisfies this shape.
 */
interface PlatformResponse {
  status(code: number): PlatformResponse;
  json(body: unknown): unknown;
}

/**
 * Fixed public bodies. Every authentication failure is one shape, and nothing here varies with
 * the cause, so a caller cannot classify *why* it was refused.
 */
const PUBLIC_BODY: Record<AuthErrorCode, { statusCode: number; error: string }> = {
  AUTHENTICATION_FAILED: { statusCode: HttpStatus.UNAUTHORIZED, error: 'authentication_failed' },
  INVALID_REQUEST: { statusCode: HttpStatus.BAD_REQUEST, error: 'invalid_request' },
  SERVICE_FAILURE: { statusCode: HttpStatus.SERVICE_UNAVAILABLE, error: 'service_unavailable' },
  // One body for every unusable recovery token, so nothing distinguishes the cause.
  RECOVERY_TOKEN_INVALID: { statusCode: HttpStatus.UNAUTHORIZED, error: 'recovery_token_invalid' },
  // A policy rejection describes the submitted password only, never the account or the token.
  INVALID_PASSWORD: { statusCode: HttpStatus.BAD_REQUEST, error: 'password_policy_violation' },
  /**
   * Stage 2.6. One body for every exceeded meter, on every endpoint and dimension.
   *
   * It deliberately does not vary by dimension, so a caller cannot learn whether it was its own
   * source, its own account, or the deployment-wide verification budget that ran out - each of which
   * would be a different thing to work around. It carries no remaining count, no bucket identifier,
   * and no key material, so a refused request reveals nothing about the counters themselves.
   *
   * The same fixed body is used for an existing account and a nonexistent one, and for a valid
   * recovery token and an invalid one, so a `429` cannot become an enumeration signal.
   */
  RATE_LIMITED: { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'rate_limited' },
};

/**
 * Translates the authentication error taxonomy into fixed HTTP responses.
 *
 * Bound to the authentication controller only. Anything it does not recognise becomes a generic
 * `503`, so driver messages, Prisma error codes, Argon2id failures, and stack traces are never
 * returned to a client.
 *
 * It deliberately does not log. A refusing error path still has to be diagnosable, but the right
 * place for that is a sanitised operational log rather than an ad-hoc write from a filter.
 */
@Catch(AuthError)
export class AuthExceptionFilter implements ExceptionFilter<AuthError> {
  catch(exception: AuthError, host: ArgumentsHost): void {
    const body = PUBLIC_BODY[exception.code] ?? PUBLIC_BODY.SERVICE_FAILURE;
    host.switchToHttp().getResponse<PlatformResponse>().status(body.statusCode).json(body);
  }
}

/**
 * Replaces malformed-request and oversized-body failures with fixed bodies, then defers to Nest's
 * own handling for everything else.
 *
 * The upstream message for a malformed JSON body quotes the offending fragment. Echoing that back
 * would return part of the submitted document - potentially including a password - to the client,
 * so these are answered here and never reach the default serialiser.
 *
 * Detection is by HTTP status, not by the body-parser error `type`. Nest re-wraps a parse failure
 * as its own `BadRequestException` before any filter sees it, which drops the original `type`; a
 * `type`-based check silently misses the case it exists to cover. The raw `type` is still checked
 * as a fallback for an error that arrives un-wrapped.
 *
 * Every other status is delegated to `BaseExceptionFilter`, which keeps the existing health
 * endpoint's `503` contract byte-for-byte unchanged. This is a safety net, not a replacement.
 *
 * Registered with the HTTP adapter so `BaseExceptionFilter` can reply through it.
 */
@Catch()
export class SafeHttpExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  constructor(
    applicationRef: HttpServer,
    private readonly securityLog?: SecurityLog,
  ) {
    super(applicationRef);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const type = (exception as { type?: unknown } | null | undefined)?.type;

    if (
      type === 'entity.parse.failed' ||
      type === 'charset.unsupported' ||
      (exception instanceof HttpException && exception.getStatus() === HttpStatus.BAD_REQUEST)
    ) {
      host
        .switchToHttp()
        .getResponse<PlatformResponse>()
        .status(HttpStatus.BAD_REQUEST)
        .json({ statusCode: HttpStatus.BAD_REQUEST, error: 'invalid_request' });
      return;
    }

    if (
      type === 'entity.too.large' ||
      (exception instanceof HttpException && exception.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE)
    ) {
      host
        .switchToHttp()
        .getResponse<PlatformResponse>()
        .status(HttpStatus.PAYLOAD_TOO_LARGE)
        .json({ statusCode: HttpStatus.PAYLOAD_TOO_LARGE, error: 'request_too_large' });
      return;
    }

    // Stage 2.7. An `HttpException` is answered by the framework filter. Every one in this codebase is
    // constructed with a hand-written, fixed body - the origin refusal, the readiness body, the accepted
    // `429` and `503` - so delegating preserves the accepted public contract exactly.
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }

    // Anything else is an unexpected failure, and this branch replaces the framework default for two
    // reasons.
    //
    // First, safety. The framework's `handleUnknownError` echoes `exception.message` for any thrown value
    // shaped like an HTTP error - an object with a string `message` and a numeric `statusCode` in
    // `[400, 600)`. That is a latent disclosure path: a future change that throws such an object, or a
    // driver error that adopts that shape, would put its own message in the response. The body below is
    // a constant and cannot vary with the cause.
    //
    // Second, observability. The framework also logs the raw exception object - which is a no-op here
    // because Nest's logger is disabled - so an unexpected failure currently produces no record at all.
    // Recording it sanitised restores the diagnostic without reintroducing the leak.
    this.securityLog?.record('unhandled_request_error', {
      reason: 'unhandled_error',
      requestId: requestIdOf(host.switchToHttp().getRequest()),
    });

    const response = host.switchToHttp().getResponse<PlatformResponse>();
    // `BaseExceptionFilter` checks `isHeadersSent` before replying; the public shape below is identical
    // to what it produced, so no accepted response contract changes.
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
