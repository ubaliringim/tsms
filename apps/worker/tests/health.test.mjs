import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthServer } from '../dist/health.js';

// Deliberately unreachable local endpoints so this suite needs no Docker and
// cannot accidentally pass because infrastructure happens to be running.
const databaseUrl = 'postgresql://tsms:hunter2@127.0.0.1:5499/tsms';
const redisUrl = 'redis://:hunter2@127.0.0.1:6399';

describe('worker process liveness and readiness', () => {
  let server;
  let origin;
  beforeAll(async () => {
    server = createHealthServer(databaseUrl, redisUrl);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('serves a minimal uncached liveness response regardless of infrastructure', async () => {
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', service: 'tsms-worker' });
  });

  it('answers 503 on readiness when infrastructure is unreachable', async () => {
    const response = await fetch(`${origin}/ready`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'degraded',
      service: 'tsms-worker',
      ready: false,
      dependencies: { database: 'down', redis: 'down' },
    });
  });

  it('never leaks connection details through readiness', async () => {
    const text = await (await fetch(`${origin}/ready`)).text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('5499');
    expect(text).not.toContain('6399');
    expect(text.toLowerCase()).not.toContain('econnrefused');
  });

  it('rejects unsupported paths and methods', async () => {
    expect((await fetch(`${origin}/jobs`)).status).toBe(404);
    expect((await fetch(`${origin}/health`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${origin}/ready`, { method: 'POST' })).status).toBe(404);
  });
});
