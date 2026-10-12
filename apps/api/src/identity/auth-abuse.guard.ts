/**
 * Abuse-protection guard for the authentication routes - Stage 2.6.
 *
 * Runs before the handler, so a refused request never reaches Argon2id, never writes a recovery
 * token, and never opens a session. That ordering is the point: enforcement that ran afterwards
 * would have already paid for the operation it was meant to prevent.
 *
 * The endpoint is attached with {@link AbuseProtected}, not passed in by hand, so a route's policy
 * and the route's decorator cannot drift apart. No request can select or influence its own limits.
 *
 * ## Decision vs response
 *
 * `canActivate` returns a boolean and records the outcome on the request; the controller writes the
 * body. Only a *fail-closed* endpoint that could not be protected raises, and it raises the existing
 * `AuthError('SERVICE_FAILURE')`, so it lands on the accepted filter's fixed `503` body. That keeps
 * every public body in one place and means the outage response cannot drift from the existing
 * sanitized contract.
 *
 * The outcome is held on the request rather than in a field on the guard: the guard is one shared
 * provider, so instance state would leak one request's decision into another's under concurrency.
 */

import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AbuseProtectionService,
  type AbuseDecisionKind,
  type AbuseRequestContext,
} from './abuse-protection.service.js';
import { clientAddressOf } from './client-identity.js';
import { AuthError, normalizeEmail } from './auth.service.js';
import type { AbuseEndpoint } from './auth-abuse-policy.js';
import { SecurityLog } from './security-log.js';
import { requestIdOf } from './security-request-context.js';

/** DI token for the abuse-protection service. */
export const ABUSE_PROTECTION = Symbol('ABUSE_PROTECTION');

/** Route metadata carrying the endpoint whose policy applies to a handler. */
export const ABUSE_ENDPOINT_METADATA = 'tsms:abuse-endpoint';

/** Marks a route as abuse-protected under one endpoint's policy. */
export const AbuseProtected = (endpoint: AbuseEndpoint): MethodDecorator =>
  SetMetadata(ABUSE_ENDPOINT_METADATA, endpoint);

export interface AbuseDecisionRecord {
  readonly kind: AbuseDecisionKind;
  readonly endpoint: AbuseEndpoint;
  /**
   * True when this endpoint requires enforcement and it could not be confirmed. The controller uses
   * it to decide whether to fail closed; nothing else reads it.
   */
  readonly enforcementUnavailable: boolean;
}

/** Symbol under which the decision is attached to the request. */
export const ABUSE_DECISION = Symbol('ABUSE_DECISION');

interface GuardedRequest {
  readonly body?: unknown;
  readonly socket?: { readonly remoteAddress?: string | undefined };
  [ABUSE_DECISION]?: AbuseDecisionRecord;
}

/**
 * Read a bounded string field from a body that has not been validated yet.
 *
 * The guard runs before the controller's strict validation, so the body is not yet known to be a
 * well-formed object. Reading it defensively means a malformed submission cannot throw out of the
 * guard and skip enforcement. Anything that is not a plain string becomes `undefined`, which for a
 * recovery token means it is hashed as malformed and still metered.
 */
function bodyString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build the request context from the transport peer and the body.
 *
 * `clientAddressOf` reads only the socket, so no request header can influence which source bucket is
 * charged. `normalizeEmail` is the accepted Stage 2.4 normalisation, so the account dimension keys on
 * exactly the string the database would look up.
 */
export function abuseContextFor(request: GuardedRequest): AbuseRequestContext {
  return {
    clientAddress: clientAddressOf(request),
    normalizedEmail: normalizeEmail(bodyString(request.body, 'email')),
    recoveryToken: bodyString(request.body, 'token'),
  };
}

/** Enforce the endpoint's policy before the handler runs. */
@Injectable()
export class AuthAbuseGuard implements CanActivate {
  constructor(
    @Inject(ABUSE_PROTECTION) private readonly protection: AbuseProtectionService,
    private readonly reflector: Reflector,
    // A value import, not `import type`: Nest constructs this guard and reads the parameter type from
    // the emitted design metadata. A type-only import is erased, so the metadata records `Function` and
    // the guard fails to resolve at startup.
    private readonly securityLog: SecurityLog,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const endpoint = this.reflector.getAllAndOverride<AbuseEndpoint | undefined>(
      ABUSE_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    // A route that carries no policy is a wiring mistake, not a licence to serve unmetered.
    if (endpoint === undefined) {
      throw new Error('AuthAbuseGuard applied to a route with no AbuseProtected endpoint');
    }

    const http = context.switchToHttp();
    const request = http.getRequest<GuardedRequest>();
    const response = http.getResponse<{ setHeader(name: string, value: string): void }>();

    const decision = await this.protection.decide(endpoint, abuseContextFor(request));

    if (decision.kind === 'limited') {
      // Set here because the controller writes the body and the header has to be on the response
      // that is actually sent. Value is already clamped to a bounded whole number of seconds.
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    }

    const record: AbuseDecisionRecord = Object.freeze({
      kind: decision.kind,
      endpoint,
      enforcementUnavailable: decision.kind === 'unavailable',
    });
    Object.defineProperty(request, ABUSE_DECISION, {
      value: record,
      enumerable: false,
      configurable: true,
    });

    if (decision.kind === 'limited') {
      // Stage 2.7. Recorded here because the guard is the last point at which the request is refused:
      // the handler never runs, so nothing downstream could observe the decision.
      //
      // A log line rather than an event row, deliberately. A denial is attacker-triggerable without
      // limit - the caller being told to back off can keep asking - and writing a row per denial would
      // turn the abuse limiter into a database-amplification attack, with the write happening exactly
      // when the system is asking the caller to stop. The log throttles per endpoint and reports a
      // suppressed count, so a sustained flood stays visible without becoming a write amplifier.
      //
      // No dimension name and no Redis key is recorded. Which meter refused is operationally useful,
      // but it is not available here without exposing the limiter's internal structure, and the public
      // `429` body is deliberately identical for every meter - this must not become a side channel that
      // an operator-facing log widens into something guessable.
      this.securityLog.record('auth_rate_limited', {
        endpoint,
        requestId: requestIdOf(request),
        reason: 'rate_limited',
      });

      // Enforcement succeeded and declined. `AuthError` is caught by the accepted authentication
      // filter, which renders the one fixed `429` body used for every exceeded meter, so the body
      // carries no indication of which dimension refused.
      throw new AuthError('RATE_LIMITED');
    }

    if (!decision.proceeds) {
      // Stage 2.7. Same reasoning as the denial above: an outage produces one refusal per in-flight
      // request, so it is recorded in the throttled log rather than as unbounded rows.
      this.securityLog.record('auth_enforcement_unavailable', {
        endpoint,
        requestId: requestIdOf(request),
        reason: 'redis_unavailable',
      });
      // Fail closed. Raised before the handler, so no Argon2id runs and no recovery token is issued
      // while enforcement is unconfirmed. `AuthError` is caught by the accepted authentication filter
      // and rendered as the same fixed `503` body used for every other service failure, so the reason
      // for the outage never reaches the client.
      throw new AuthError('SERVICE_FAILURE');
    }

    return true;
  }
}

/**
 * Read back what the guard decided.
 *
 * Returns `null` when the guard did not run. Callers treat that as "no decision", never as "allowed".
 */
export function abuseDecisionOf(request: unknown): AbuseDecisionRecord | null {
  if (typeof request !== 'object' || request === null) return null;
  return (request as GuardedRequest)[ABUSE_DECISION] ?? null;
}
