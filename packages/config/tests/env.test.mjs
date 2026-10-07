import { describe, expect, it } from 'vitest';
import { parseApiEnvironment, parseWorkerEnvironment } from '../dist/env.js';

describe('server environment boundary', () => {
  it('uses safe local defaults without requiring external services', () => {
    expect(parseApiEnvironment({})).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
    });
    expect(parseWorkerEnvironment({}).WORKER_HEALTH_PORT).toBe(4001);
  });

  it('parses explicitly configured ports and strips unrelated values', () => {
    expect(
      parseApiEnvironment({ API_PORT: '4100', NODE_ENV: 'test', UNRELATED_SECRET: 'private' }),
    ).toEqual({ NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: 4100 });
  });

  it.each(['', '0', '-1', '65536', '12.5', '1e3', 'not-a-port'])(
    'rejects malformed or out-of-range port %j before startup',
    (value) => {
      expect(() => parseApiEnvironment({ API_PORT: value })).toThrow('API_PORT');
      expect(() => parseWorkerEnvironment({ WORKER_HEALTH_PORT: value })).toThrow(
        'WORKER_HEALTH_PORT',
      );
    },
  );

  it('rejects invalid mode and empty bind host without exposing supplied values', () => {
    expect(() => parseApiEnvironment({ NODE_ENV: 'sensitive-input', API_HOST: '' })).toThrow(
      'Invalid environment configuration: NODE_ENV, API_HOST',
    );
    try {
      parseApiEnvironment({ API_PORT: 'private-value' });
    } catch (error) {
      expect(error.message).not.toContain('private-value');
    }
  });
});
