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
} from '@nestjs/common';
import { AuthError, AuthService, type PublicUserProfile } from './auth.service.js';
import {
  clearSessionCookie,
  cookieMaxAgeSeconds,
  readSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_POLICY,
  type SessionCookiePolicy,
} from './auth-cookie.js';
import { AuthExceptionFilter } from './auth-exception.filter.js';
import { TrustedOriginGuard } from './trusted-origin.guard.js';

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

const JSON_CONTENT_TYPE = /^application\/json\s*(;.*)?$/i;

/**
 * HTTP transport for global identity authentication.
 *
 * The controller owns request parsing, cookie transport, and nothing else: credential
 * verification, session lifecycle, and failure classification all live in the accepted Stage 2.2
 * and Stage 2.3 primitives and in `AuthService`. No route here consults a school, tenant,
 * membership, role, or permission, because none exists.
 */
@Controller('auth')
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
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
  @UseGuards(TrustedOriginGuard)
  async login(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) response: PlatformResponse,
    @Body() body: unknown,
  ): Promise<LoginBody> {
    this.requireJson(request);
    const input = this.readLoginInput(body);

    const result = await this.auth.login(input.email, input.password);

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
  async me(@Req() request: PlatformRequest): Promise<CurrentUserBody> {
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
  @UseGuards(TrustedOriginGuard)
  async logout(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) response: PlatformResponse,
  ): Promise<void> {
    const token = readSessionCookie(request.headers['cookie'], this.cookiePolicy);
    if (token !== null) await this.auth.logout(token);
    response.setHeader('Set-Cookie', clearSessionCookie(this.cookiePolicy));
  }

  /**
   * Require a JSON request.
   *
   * The body parser ignores a non-JSON content type, which would otherwise turn a wrong content
   * type into a confusing `400` about a missing field.
   */
  private requireJson(request: PlatformRequest): void {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType)) {
      throw new AuthError('INVALID_REQUEST');
    }
  }

  /**
   * Read the login body strictly.
   *
   * Only a plain object with exactly `email` and `password`, both strings, is accepted. Unknown
   * keys are refused rather than ignored so a client cannot believe a field was honoured when it
   * was dropped. No value is coerced: a number, array, boolean, or object is not silently turned
   * into a string, and no submitted value appears in the error.
   */
  private readLoginInput(body: unknown): { email: string; password: string } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AuthError('INVALID_REQUEST');
    }
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('email') || !keys.includes('password')) {
      throw new AuthError('INVALID_REQUEST');
    }
    const record = body as Record<string, unknown>;
    if (typeof record['email'] !== 'string' || typeof record['password'] !== 'string') {
      throw new AuthError('INVALID_REQUEST');
    }
    return { email: record['email'], password: record['password'] };
  }
}
