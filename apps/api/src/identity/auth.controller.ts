import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthError, AuthService, type PublicUserProfile } from './auth.service.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import {
  clearSessionCookie,
  cookieMaxAgeSeconds,
  readSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_POLICY,
  type SessionCookiePolicy,
} from './auth-cookie.js';
import { AuthExceptionFilter } from './auth-exception.filter.js';
import { requestIdOf } from './security-request-context.js';
import { TrustedOriginGuard } from './trusted-origin.guard.js';
import { AbuseProtected, AuthAbuseGuard, abuseDecisionOf } from './auth-abuse.guard.js';
import { AbuseReservationInterceptor } from './abuse-reservation.interceptor.js';
import { parseAuthBody, type AuthBodyKind } from './auth-request-shape.js';

/** DI token for an injectable clock, so cookie lifetimes are deterministic under test. */
export const AUTH_CLOCK = Symbol('AUTH_CLOCK');

/**
 * Minimal structural views of the platform request and response.
 *
 * `apps/api` does not depend on `express` or `@types/express`, so only the members used here are
 * declared. Both are satisfied by the Express objects Nest passes through.
 */
interface PlatformRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}
interface PlatformResponse {
  setHeader(name: string, value: string | readonly string[]): void;
}

export interface LoginBody {
  readonly user: PublicUserProfile;
}
export interface CurrentUserBody {
  readonly user: PublicUserProfile;
}

/**
 * The one body every password-recovery request receives - Stage 2.5.
 *
 * It states the outcome without asserting anything about the account, so it cannot become an
 * enumeration oracle.
 */
export const RECOVERY_ACCEPTED_MESSAGE =
  'If the account is eligible, password recovery instructions will be sent.';

/**
 * HTTP transport for global identity authentication.
 *
 * The controller owns request parsing, cookie transport, and nothing else: credential
 * verification, session lifecycle, and failure classification all live in the accepted Stage 2.2
 * and Stage 2.3 primitives and in `AuthService`. No route here consults a school, tenant,
 * membership, role, or permission, because none exists.
 */
@Controller('auth')
@UseInterceptors(AbuseReservationInterceptor)
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: PasswordRecoveryService,
    @Inject(SESSION_COOKIE_POLICY) private readonly cookiePolicy: SessionCookiePolicy,
    @Inject(AUTH_CLOCK) private readonly now: () => Date,
  ) {}

  /**
   * Exchange a submitted address and password for a server-managed browser session.
   *
   * A session is created only after the password verifies, and the raw token is returned only in
   * the `Set-Cookie` header - never in the body, a header a client might log, or a URL. The
   * controller does not read the trusted-origin allowlist; that decision belongs to the guard,
   * which cannot be bypassed by forgetting to call a helper.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AbuseProtected('login')
  @UseGuards(TrustedOriginGuard, AuthAbuseGuard)
  async login(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) response: PlatformResponse,
    @Body() body: unknown,
  ): Promise<LoginBody> {
    this.refuseIfLimited(request);
    const input = this.readBody('login', request, body);

    const result = await this.auth.login(input['email'], input['password'], requestIdOf(request));

    response.setHeader(
      'Set-Cookie',
      serializeSessionCookie(
        this.cookiePolicy,
        result.token,
        // Bounded by the session's own absolute expiry, so the browser can never hold the cookie
        // longer than the server will accept the token.
        cookieMaxAgeSeconds(result.expiresAt, this.now()),
      ),
    );
    return { user: result.user };
  }

  /**
   * Return the minimal global profile behind the session cookie.
   *
   * Safe to leave unguarded by the origin check: it changes nothing, and requiring `Origin` would
   * break direct navigation. `SameSite=Lax` is what stops a cross-site request from carrying the
   * cookie here at all.
   */
  @Get('me')
  @AbuseProtected('me')
  @UseGuards(AuthAbuseGuard)
  async me(@Req() request: PlatformRequest): Promise<CurrentUserBody> {
    this.refuseIfLimited(request);
    const token = readSessionCookie(request.headers['cookie'], this.cookiePolicy);
    if (token === null) throw new AuthError('AUTHENTICATION_FAILED');
    return { user: await this.auth.currentUser(token) };
  }

  /**
   * Revoke the session named by the cookie and clear it.
   *
   * Always `204` with no body, whether or not a valid session was presented, so the response
   * reveals nothing about whether the token ever existed. Only the presented session is revoked.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AbuseProtected('logout')
  @UseGuards(TrustedOriginGuard, AuthAbuseGuard)
  async logout(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) response: PlatformResponse,
  ): Promise<void> {
    // Stage 2.6. A declined meter refuses before revocation, and a `Redis` outage does not stop
    // logout at all: revocation is a PostgreSQL write, so the cookie is still cleared and the session
    // is still revoked, and the `204` still describes what actually happened.
    this.refuseIfLimited(request);
    const token = readSessionCookie(request.headers['cookie'], this.cookiePolicy);
    if (token !== null) await this.auth.logout(token, requestIdOf(request));
    response.setHeader('Set-Cookie', clearSessionCookie(this.cookiePolicy));
  }

  /**
   * Begin password recovery for an address - Stage 2.5.
   *
   * Always answers `202` with the same fixed body whether or not the account exists, is eligible, or
   * a token was created. The raw token and the reset URL never reach the client.
   */
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @AbuseProtected('forgot')
  @UseGuards(TrustedOriginGuard, AuthAbuseGuard)
  async forgotPassword(@Req() request: PlatformRequest, @Body() body: unknown): Promise<unknown> {
    this.refuseIfLimited(request);
    const input = this.readBody('forgot', request, body);
    await this.recovery.requestRecovery(input['email'], requestIdOf(request));
    return { message: RECOVERY_ACCEPTED_MESSAGE };
  }

  /**
   * Complete password recovery - Stage 2.5.
   *
   * Consumes the token, replaces the credential, supersedes other tokens, and revokes the user's
   * sessions in one transaction. Sets no cookie and creates no session: the user must log in again.
   */
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AbuseProtected('reset')
  @UseGuards(TrustedOriginGuard, AuthAbuseGuard)
  async resetPassword(@Req() request: PlatformRequest, @Body() body: unknown): Promise<void> {
    this.refuseIfLimited(request);
    const input = this.readBody('reset', request, body);
    await this.recovery.resetPassword(input['token'], input['newPassword'], requestIdOf(request));
  }

  /**
   * Refuse a request whose abuse-protection meter declined it.
   *
   * Called as the first statement of every protected handler, so the refusal happens before any
   * expensive work, any database write, and any token issuance. The guard has already set
   * `Retry-After` and has already thrown for an unconfirmable meter on a fail-closed endpoint, so
   * this only covers the case where enforcement worked and declined.
   */
  private refuseIfLimited(request: PlatformRequest): void {
    const decision = abuseDecisionOf(request);
    if (decision?.kind === 'limited') throw new AuthError('RATE_LIMITED');
  }

  /**
   * Read a request body strictly through the shared definition.
   *
   * The abuse guard classifies a request as well-formed or malformed with this same function, so the two cannot
   * disagree about which requests are malformed. A malformed request is refused with the fixed
   * `invalid_request` body and nothing about it is echoed.
   */
  private readBody(
    kind: AuthBodyKind,
    request: PlatformRequest,
    body: unknown,
  ): Record<string, string> {
    const parsed = parseAuthBody(kind, request.headers['content-type'], body);
    if (parsed === null) throw new AuthError('INVALID_REQUEST');
    return parsed;
  }
}
