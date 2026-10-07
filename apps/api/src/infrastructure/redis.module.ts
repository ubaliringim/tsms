import { Global, Module, type DynamicModule } from '@nestjs/common';
import { RedisService } from './redis.service.js';

export interface RedisModuleOptions {
  /** Already validated by `@tsms/config`. Never read from `process.env` here. */
  readonly redisUrl: string;
}

@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        {
          provide: RedisService,
          useFactory: () => new RedisService(options.redisUrl),
        },
      ],
      exports: [RedisService],
    };
  }
}
