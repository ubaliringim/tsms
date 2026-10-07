import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnvironment } from '@tsms/config';
import { HealthController } from './health.controller.js';
import { DatabaseModule } from './infrastructure/database.module.js';
import { RedisModule } from './infrastructure/redis.module.js';

@Module({})
export class AppModule {
  /**
   * Infrastructure endpoints arrive as already-validated configuration rather than
   * being read from `process.env` inside modules, so an unvalidated value can
   * never reach a client or a connection pool.
   */
  static forRoot(environment: ApiEnvironment): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({ databaseUrl: environment.DATABASE_URL }),
        RedisModule.forRoot({ redisUrl: environment.REDIS_URL }),
      ],
      controllers: [HealthController],
    };
  }
}
