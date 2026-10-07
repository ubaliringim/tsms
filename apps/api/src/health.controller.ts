import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import type { DependencyState } from './infrastructure/database.service.js';
import { DatabaseService } from './infrastructure/database.service.js';
import { RedisService } from './infrastructure/redis.service.js';

export interface ReadinessBody {
  readonly status: 'ok' | 'degraded';
  readonly service: 'tsms-api';
  readonly ready: boolean;
  readonly dependencies: { readonly database: DependencyState; readonly redis: DependencyState };
}

@Controller()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Process liveness. Answers 200 whenever the HTTP server is serving, with no
   * dependency involved, so a database outage cannot cause an orchestrator to
   * restart an otherwise healthy process.
   */
  @Get('health')
  @Header('Cache-Control', 'no-store')
  getHealth() {
    return { status: 'ok', service: 'tsms-api' };
  }

  /**
   * Dependency readiness. Answers 503 when PostgreSQL or Redis is unreachable,
   * so a load balancer stops routing requests that need them.
   *
   * The body reports only which dependency is down. Driver messages, connection
   * strings, and credentials are never returned.
   */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async getReadiness(): Promise<ReadinessBody> {
    const [database, redis] = await Promise.all([this.database.check(), this.redis.check()]);
    const ready = database === 'up' && redis === 'up';
    const body: ReadinessBody = {
      status: ready ? 'ok' : 'degraded',
      service: 'tsms-api',
      ready,
      dependencies: { database, redis },
    };
    if (!ready) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
