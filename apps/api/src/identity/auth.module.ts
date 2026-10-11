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
import {
  PasswordRecoveryService,
  type RecoveryPolicySettings,
} from './password-recovery.service.js';
import {
  recoveryDeliveryFor,
  type PasswordRecoveryDelivery,
} from './password-recovery-delivery.js';
import { RECOVERY_CLOCK } from './password-recovery-token.js';
import { AbuseProtectionService } from './abuse-protection.service.js';
import { ABUSE_PROTECTION, AuthAbuseGuard } from './auth-abuse.guard.js';
import { AbuseReservationInterceptor } from './abuse-reservation.interceptor.js';
import { Argon2idAdmissionService } from './argon2id-admission.service.js';
import { ARGON2ID_CONCURRENCY } from './auth-abuse-policy.js';
import { DatabaseService } from '../infrastructure/database.service.js';
import { RedisService } from '../infrastructure/redis.service.js';

/** DI token for the delivery adapter, so a test can substitute an inspectable one. */
export const RECOVERY_DELIVERY = Symbol('RECOVERY_DELIVERY');
/** DI token for the validated recovery settings. */
export const RECOVERY_POLICY_SETTINGS = Symbol('RECOVERY_POLICY_SETTINGS');

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
          /**
           * Stage 2.6 hardening. The deployment-wide bound on *simultaneous* Argon2id operations.
           *
           * Shares the process-owned Redis client, so the bound is held across every API instance rather
           * than per process - a process-local counter would let each replica allow its own share and the
           * fleet total would scale with the number of replicas. Deliberately not optional: both services
           * require it, because every verification on those paths allocates 64 MiB.
           */
          provide: Argon2idAdmissionService,
          useFactory: (redis: RedisService) =>
            new Argon2idAdmissionService(redis.redis, ARGON2ID_CONCURRENCY),
          inject: [RedisService],
        },
        {
          provide: AuthService,
          useFactory: (
            database: DatabaseService,
            credentials: PasswordCredentialService,
            sessions: SessionService,
            argon2id: Argon2idAdmissionService,
          ) => new AuthService(database.prisma, credentials, sessions, argon2id),
          inject: [
            DatabaseService,
            PasswordCredentialService,
            SessionService,
            Argon2idAdmissionService,
          ],
        },
        {
          // Stage 2.5. Delivery is explicit configuration: `disabled` selects the adapter that
          // refuses everything, so recovery fails closed without a real mail provider.
          provide: RECOVERY_DELIVERY,
          useFactory: (): PasswordRecoveryDelivery =>
            recoveryDeliveryFor(environment.API_PASSWORD_RECOVERY_DELIVERY_MODE),
        },
        {
          provide: RECOVERY_POLICY_SETTINGS,
          useValue: Object.freeze({
            mode: environment.API_PASSWORD_RECOVERY_DELIVERY_MODE,
            // Validated as an absolute URL at startup, so recovery links are never header-derived.
            urlBase: environment.API_PASSWORD_RECOVERY_URL_BASE ?? 'https://invalid.localhost/',
          }),
        },
        { provide: RECOVERY_CLOCK, useValue: () => new Date() },
        /**
         * Stage 2.6. One service per process, sharing the process-owned Redis client, so the meters
         * are Redis-backed rather than process-local and therefore hold across API instances.
         *
         * The secret arrives as already-validated configuration. Reading `process.env` here would let
         * an unvalidated value reach key derivation, which is the same reason the origin allowlist is
         * injected rather than parsed.
         */
        {
          provide: ABUSE_PROTECTION,
          useFactory: (redis: RedisService) =>
            new AbuseProtectionService({
              secret: environment.API_RATE_LIMIT_HMAC_SECRET,
              redis: redis.redis,
            }),
          inject: [RedisService],
        },
        { provide: AbuseProtectionService, useExisting: ABUSE_PROTECTION },
        AuthAbuseGuard,
        /**
         * Returns a reservation for an attempt that turned out not to be abuse, which is what keeps a
         * legitimate sign-in free while still bounding a concurrent burst of failures. Registered here so
         * the interceptor receives the same validated protection instance the guard uses.
         */
        AbuseReservationInterceptor,
        {
          provide: PasswordRecoveryService,
          useFactory: (
            database: DatabaseService,
            delivery: PasswordRecoveryDelivery,
            settings: RecoveryPolicySettings,
            argon2id: Argon2idAdmissionService,
            clock: () => Date,
          ) => new PasswordRecoveryService(database.prisma, delivery, settings, argon2id, clock),
          inject: [
            DatabaseService,
            RECOVERY_DELIVERY,
            RECOVERY_POLICY_SETTINGS,
            Argon2idAdmissionService,
            RECOVERY_CLOCK,
          ],
        },
        TrustedOriginGuard,
      ],
      exports: [AuthService, PasswordRecoveryService, RECOVERY_DELIVERY],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(uncacheableAuthentication).forRoutes(
      { path: 'auth/login', method: RequestMethod.POST },
      { path: 'auth/me', method: RequestMethod.GET },
      { path: 'auth/logout', method: RequestMethod.POST },
      // Stage 2.5 recovery routes: uncacheable like every other authentication response.
      { path: 'auth/password/forgot', method: RequestMethod.POST },
      { path: 'auth/password/reset', method: RequestMethod.POST },
    );
  }
}
