import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../dist/application.js';

describe('API HTTP boundary', () => {
  let app;
  let origin;
  beforeAll(async () => {
    app = await createApplication();
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

  it('does not expose an unimplemented product route', async () => {
    expect((await fetch(`${origin}/students`)).status).toBe(404);
  });
});
