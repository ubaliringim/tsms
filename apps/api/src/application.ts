import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { ApiEnvironment } from '@tsms/config';
import { AppModule } from './app.module.js';

export async function createApplication(environment: ApiEnvironment) {
  const app = await NestFactory.create(AppModule.forRoot(environment), { logger: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Closes the Prisma connection pool and the Redis connection on shutdown.
  app.enableShutdownHooks();
  return app;
}
