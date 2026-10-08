import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { HttpServer } from '@nestjs/common';
import { AuthError, type AuthErrorCode } from './auth.service.js';

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
  constructor(applicationRef: HttpServer) {
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

    super.catch(exception, host);
  }
}
