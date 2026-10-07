import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthServer } from '../dist/health.js';

describe('worker process liveness', () => {
  let server;
  let origin;
  beforeAll(async () => {
    server = createHealthServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('serves a minimal uncached liveness response without claiming queue readiness', async () => {
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', service: 'tsms-worker' });
  });
  it('rejects unsupported paths and methods', async () => {
    expect((await fetch(`${origin}/jobs`)).status).toBe(404);
    expect((await fetch(`${origin}/health`, { method: 'POST' })).status).toBe(404);
  });
});
