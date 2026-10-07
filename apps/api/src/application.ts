import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

export async function createApplication() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}
