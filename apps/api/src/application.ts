import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiEnvironment } from '@tsms/config';
import { AppModule } from './app.module.js';
import { SafeHttpExceptionFilter } from './identity/auth-exception.filter.js';
import { authJsonLimitGuard, JSON_BODY_LIMIT } from './identity/auth-body-limit.js';
import { securityRequestContext } from './identity/security-request-context.js';
import { SECURITY_LOG, type SecurityLog } from './identity/security-log.js';

/**
 * Nest error classes whose messages name only classes and modules, so they are safe to print.
 *
 * Anything else - a driver error, a factory failure - is reduced to its class name, because a connection
 * error can carry a URL or a password and startup output goes to an operator's terminal and log sink.
 */
const DEPENDENCY_ERRORS: ReadonlySet<string> = new Set([
  'UnknownDependenciesException',
  'UndefinedDependencyException',
  'UnknownModuleException',
  'InvalidModuleException',
  'UndefinedModuleException',
  'CircularDependencyException',
]);

export function startupFailure(error: unknown): Error {
  const name = error instanceof Error ? error.constructor.name : 'unknown';
  return DEPENDENCY_ERRORS.has(name) && error instanceof Error
    ? new Error(`API startup failed: ${error.message}`)
    : new Error(`API startup failed (${name})`);
}

export async function createApplication(environment: ApiEnvironment) {
  let app: NestExpressApplication;
  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(environment), {
      logger: false,
      // Stage 2.7. With the logger disabled, Nest's default `abortOnError` calls `process.abort()` on a
      // bootstrap failure and prints nothing, so a dependency-injection mistake killed the process with
      // no output at all. Rejecting instead lets `main.ts` report it and exit with a code, and lets a
      // test see an ordinary failure rather than a dead worker.
      abortOnError: false,
      // The parser is registered explicitly below so the limit and its early rejection can both be
      // controlled here, instead of relying on framework defaults.
      bodyParser: false,
    });
  } catch (error) {
    throw startupFailure(error);
  }
  // Stage 2.7. First in the chain, so every request - including one rejected before it reaches a route -
  // carries a server-generated correlation id. It is generated here and any inbound `X-Request-Id` is
  // ignored, so no caller-supplied value can reach an audit row or a log line.
  //
  // The filter shares the per-process instance the guard and services use, so every recorder draws on one
  // throttle state and the documented bound is not multiplied by the number of consumers.
  const securityLog = app.get<SecurityLog>(SECURITY_LOG, { strict: false });
  app.use(securityRequestContext);
  // Ordered before the parser: it rejects an oversized declared body without parsing it.
  app.use(authJsonLimitGuard);
  // Defence in depth for a chunked body that understates or omits its length.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Replaces malformed-JSON and oversized-body errors with fixed public bodies, answers `HttpException`
  // through the framework filter, and answers anything else with a constant `500` plus a sanitised log
  // line. Registered with the HTTP adapter because BaseExceptionFilter replies through it.
  app.useGlobalFilters(new SafeHttpExceptionFilter(app.getHttpAdapter(), securityLog));
  // Closes the Prisma connection pool and the Redis connection on shutdown.
  app.enableShutdownHooks();
  return app;
}
