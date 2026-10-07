import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

export interface DatabaseModuleOptions {
  /** Already validated by `@tsms/config`. Never read from `process.env` here. */
  readonly databaseUrl: string;
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DatabaseService,
          useFactory: () => new DatabaseService(options.databaseUrl),
        },
      ],
      exports: [DatabaseService],
    };
  }
}
