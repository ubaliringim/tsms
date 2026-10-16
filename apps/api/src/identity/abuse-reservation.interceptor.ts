/**
 * Reservation refund - Stage 2.6 hardening.
 *
 * Admission **reserves** a token on every failure-metered dimension so that concurrent requests genuinely
 * contend for the same budget instead of all reading it untouched. This interceptor returns that
 * reservation whenever the attempt turned out not to be abuse, which is what makes "a legitimate success
 * is free" an enforced property rather than an aspiration.
 *
 * ## What is refunded, and what is not
 *
 * Reservation returned:
 *
 * - a successful login or recovery reset;
 * - a malformed body, an untrusted origin, a password-policy violation;
 * - any operational failure, including `SERVICE_FAILURE` raised by the services themselves.
 *
 * Reservation kept as a charge:
 *
 * - `AUTHENTICATION_FAILED`, for login: a wrong password, an unknown address, a disabled account, or a
 *   missing credential. These are the guessing attempts the meter exists to count, and they are already
 *   externally indistinguishable, so charging them cannot become an oracle.
 * - `RECOVERY_TOKEN_INVALID`, for reset: an unknown, expired, consumed, superseded, or malformed token.
 *
 * A guard refusal is neither. The meter refused the request and wrote nothing, so there is no reservation
 * to return and no charge to make; touching it again would let a caller drain a budget by asking past it.
 *
 * ## Ordering
 *
 * The refund runs after the handler has produced its outcome and never changes what the client sees: the
 * original failure is always re-raised, so the accepted `AuthExceptionFilter` still produces the response.
 * Refund failures are swallowed, because a lost refund costs this caller one unit of its own allowance,
 * while surfacing it would turn an ordinary wrong password into a `503`.
 */

import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import {
  ABUSE_ENDPOINT_METADATA,
  ABUSE_PROTECTION,
  abuseContextFor,
  abuseDecisionOf,
} from './auth-abuse.guard.js';
import { AbuseProtectionService } from './abuse-protection.service.js';
import { AuthError } from './auth.service.js';
import type { AbuseEndpoint } from './auth-abuse-policy.js';

/**
 * Error codes for which a reservation is kept as a charge.
 *
 * Exported so the classification is asserted directly rather than inferred from handler behaviour: which
 * outcomes cost the caller budget is a security decision, and it should not be able to change silently if
 * a handler is refactored.
 */
export const CHARGED_ERROR_CODES: ReadonlySet<string> = new Set([
  'AUTHENTICATION_FAILED',
  'RECOVERY_TOKEN_INVALID',
]);

/** Codes a guard raises before any handler work, so no reservation was ever taken. */
function isGuardRefusal(failure: unknown): boolean {
  const code = (failure as { code?: unknown } | null | undefined)?.code;
  return code === 'RATE_LIMITED' || code === 'SERVICE_FAILURE';
}

@Injectable()
export class AbuseReservationInterceptor implements NestInterceptor {
  constructor(
    @Inject(ABUSE_PROTECTION) private readonly protection: AbuseProtectionService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const endpoint = this.reflector.getAllAndOverride<AbuseEndpoint | undefined>(
      ABUSE_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    // An unannotated route has no meters to reserve or refund; its behaviour is left untouched.
    if (endpoint === undefined) return next.handle();

    const request = context.switchToHttp().getRequest();
    const contextOf = () => abuseContextFor(request, endpoint);
    // Stage 2.9. A request that took no reservation (a malformed one, which the guard routed to its own meter)
    // has nothing to return. Refunding it anyway would credit the caller with tokens it never spent.
    const reserved = abuseDecisionOf(request)?.reserved === true;

    /**
     * Return this request's reservation.
     *
     * Failures are swallowed: a lost refund costs this caller one unit of its own allowance, and
     * surfacing it would turn an ordinary wrong password into a `503`.
     */
    const refund = async (): Promise<void> => {
      if (!reserved) return;
      try {
        await this.protection.refundFor(endpoint, contextOf());
      } catch {
        // Deliberately swallowed. See the comment above.
      }
    };

    /**
     * A handler that completes normally was a legitimate request, so its reservation is returned.
     *
     * This is the path that makes "a successful attempt is free" true rather than merely intended:
     * without it, every correct sign-in would permanently drain that account's allowance and the user
     * would be locked out by their own successful logins.
     */
    const onSuccess = async (value: unknown): Promise<unknown> => {
      await refund();
      return value;
    };

    /** Decide the fate of a failed request, refund if it was not abuse, and always re-raise. */
    const settle = async (failure: unknown): Promise<never> => {
      // Stage 2.9. A refusal raised inside the handler by the global Argon2id budget or the success budget
      // carries a retry hint. The request took a reservation but attempted nothing, so it is returned.
      if (failure instanceof AuthError && failure.retryAfterSeconds !== undefined) {
        await refund();
        throw failure;
      }

      // A guard refusal wrote nothing, so there is no reservation to return. Touching the meter again
      // would let a caller drain a budget simply by asking past it.
      if (isGuardRefusal(failure)) throw failure;

      // A guessing attempt keeps its reservation as a charge.
      const charged = failure instanceof AuthError && CHARGED_ERROR_CODES.has(failure.code);
      if (!charged) await refund();

      // The original failure is what the client sees, always.
      throw failure;
    };

    return next.handle().pipe(
      mergeMap((value: unknown) => from(onSuccess(value))),
      catchError((failure: unknown) => from(settle(failure))),
    );
  }
}
