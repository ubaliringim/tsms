import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../dist/health.controller.js';

const service = (states) => ({
  check: async () => states.state,
});

describe('readiness response shape', () => {
  it('reports ready when every dependency is reachable', async () => {
    const controller = new HealthController(service({ state: 'up' }), service({ state: 'up' }));
    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      service: 'tsms-api',
      ready: true,
      dependencies: { database: 'up', redis: 'up' },
    });
  });

  it.each([
    ['database', { database: 'down', redis: 'up' }],
    ['redis', { database: 'up', redis: 'down' }],
    ['both', { database: 'down', redis: 'down' }],
  ])('answers 503 when the %s dependency is unavailable', async (_label, states) => {
    const controller = new HealthController(
      service({ state: states.database }),
      service({ state: states.redis }),
    );
    await expect(controller.getReadiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.getReadiness()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'degraded',
        service: 'tsms-api',
        ready: false,
        dependencies: states,
      },
    });
  });
});

describe('liveness independence', () => {
  it('does not consult any dependency', () => {
    const database = {
      check: () => {
        throw new Error('readiness must not run');
      },
    };
    const redis = {
      check: () => {
        throw new Error('readiness must not run');
      },
    };
    const controller = new HealthController(database, redis);
    expect(controller.getHealth()).toEqual({ status: 'ok', service: 'tsms-api' });
  });
});
