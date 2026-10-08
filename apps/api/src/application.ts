import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiEnvironment } from '@tsms/config';
import { AppModule } from './app.module.js';
import { SafeHttpExceptionFilter } from './identity/auth-exception.filter.js';
import { authJsonLimitGuard, JSON_BODY_LIMIT } from './identity/auth-body-limit.js';

export async function createApplication(environment: ApiEnvironment) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(environment), {
    logger: false,
    // The parser is registered explicitly below so the limit and its early rejection can both be
    // controlled here, instead of relying on framework defaults.
    bodyParser: false,
  });
  // Ordered before the parser: it rejects an oversized declared body without parsing it.
  app.use(authJsonLimitGuard);
  // Defence in depth for a chunked body that understates or omits its length.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Replaces malformed-JSON and oversized-body errors with fixed public bodies, then defers to
  // Nest's own handling for everything else. Registered with the HTTP adapter because
  // BaseExceptionFilter replies through it.
  app.useGlobalFilters(new SafeHttpExceptionFilter(app.getHttpAdapter()));
  // Closes the Prisma connection pool and the Redis connection on shutdown.
  app.enableShutdownHooks();
  return app;
}
