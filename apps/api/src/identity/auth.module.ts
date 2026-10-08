import {
  MiddlewareConsumer,
  Module,
  type DynamicModule,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import type { ApiEnvironment } from '@tsms/config';
import { AuthController, AUTH_CLOCK } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { sessionCookiePolicy, SESSION_COOKIE_POLICY } from './auth-cookie.js';
import { PasswordCredentialService } from './password-credential.service.js';
import { SessionService } from './session.service.js';
import { TRUSTED_ORIGINS, TrustedOriginGuard } from './trusted-origin.guard.js';
import { DatabaseService } from '../infrastructure/database.service.js';

/**
 * Minimal structural view of the platform response, for the cache-header middleware.
 */
interface PlatformResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Mark authentication responses uncacheable before the handler runs.
 *
 * Applied as route-bound middleware rather than a header decorator so it also covers error
 * responses, which Nest's `@Header` does not reach. `Vary: Origin` accompanies `no-store` because
 * the same URL answers differently depending on the submitted origin.
 */
function uncacheableAuthentication(
  _request: unknown,
  response: PlatformResponse,
  next: () => void,
): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
  next();
}

/**
 * Stage 2.4 HTTP authentication.
 *
 * Provides the accepted Stage 2.2 and Stage 2.3 primitives from the process-owned Prisma client,
 * so this stage adds no second database connection and no second token implementation. It carries
 * no authorization: nothing here reads tenant, school, membership, role, or permission state,
 * because none of that exists yet.
 */
@Module({})
export class AuthModule implements NestModule {
  /**
   * The allowlist arrives as already-validated configuration. Reading `process.env` inside a
   * guard would let an unvalidated value reach the CSRF decision.
   */
  static forRoot(environment: ApiEnvironment): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        {
          provide: TRUSTED_ORIGINS,
          useValue: Object.freeze([...environment.API_TRUSTED_ORIGINS]),
        },
        {
          // Derived from already-validated NODE_ENV. There is no toggle that could weaken the
          // production cookie, because the transport attributes are not configuration.
          provide: SESSION_COOKIE_POLICY,
          useValue: sessionCookiePolicy(environment.NODE_ENV),
        },
        { provide: AUTH_CLOCK, useValue: () => new Date() },
        {
          provide: PasswordCredentialService,
          useFactory: (database: DatabaseService) => new PasswordCredentialService(database.prisma),
          inject: [DatabaseService],
        },
        {
          provide: SessionService,
          useFactory: (database: DatabaseService) => new SessionService(database.prisma),
          inject: [DatabaseService],
        },
        {
          provide: AuthService,
          useFactory: (
            database: DatabaseService,
            credentials: PasswordCredentialService,
            sessions: SessionService,
          ) => new AuthService(database.prisma, credentials, sessions),
          inject: [DatabaseService, PasswordCredentialService, SessionService],
        },
        TrustedOriginGuard,
      ],
      exports: [AuthService],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(uncacheableAuthentication)
      .forRoutes(
        { path: 'auth/login', method: RequestMethod.POST },
        { path: 'auth/me', method: RequestMethod.GET },
        { path: 'auth/logout', method: RequestMethod.POST },
      );
  }
}
