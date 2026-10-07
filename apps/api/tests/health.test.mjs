import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../dist/application.js';

// Deliberately unreachable local endpoints: these tests must prove that process
// liveness does not depend on infrastructure, and that readiness reports a
// dependency as down without leaking connection details. Nothing here requires
// Docker, and nothing here can accidentally succeed because Docker is running.
const environment = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: 4000,
  DATABASE_URL: 'postgresql://tsms:hunter2@127.0.0.1:5499/tsms',
  REDIS_URL: 'redis://:hunter2@127.0.0.1:6399',
};

describe('API HTTP boundary', () => {
  let app;
  let origin;
  beforeAll(async () => {
    app = await createApplication(environment);
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves uncached process liveness without exposing environment or dependencies', async () => {
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(await response.json()).toEqual({ status: 'ok', service: 'tsms-api' });
  });

  it('answers 503 on readiness when infrastructure is unreachable', async () => {
    const response = await fetch(`${origin}/ready`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = await response.json();
    expect(body).toEqual({
      status: 'degraded',
      service: 'tsms-api',
      ready: false,
      dependencies: { database: 'down', redis: 'down' },
    });
  });

  it('never leaks connection details through readiness', async () => {
    const text = await (await fetch(`${origin}/ready`)).text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('127.0.0.1:5499');
    expect(text).not.toContain('127.0.0.1:6399');
    expect(text.toLowerCase()).not.toContain('econnrefused');
  });

  it('does not expose an unimplemented product route', async () => {
    const response = await fetch(`${origin}/students`);
    expect(response.status).toBe(404);
  });
});
