import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeRedis, createRedisClient, pingRedis } from '../dist/client.js';
import { assertDisposableTestRedis, redisDatabaseIndexOf } from '../dist/testing.js';

let client;
let index;

beforeAll(() => {
  const integration = parseIntegrationEnvironment(process.env);
  const url = assertDisposableTestRedis(integration.TEST_REDIS_URL);
  index = redisDatabaseIndexOf(url);
  client = createRedisClient(url);
});

afterAll(async () => {
  if (client) {
    await closeRedis(client);
  }
});

describe('Redis integration against a real Redis instance', () => {
  it('connects lazily and answers PING', async () => {
    await expect(pingRedis(client)).resolves.toBeUndefined();
  });

  it('round-trips a value in the non-default logical database', async () => {
    const key = `tsms:integration:${process.pid}:roundtrip`;
    expect(await client.set(key, 'value-1')).toBe('OK');
    expect(await client.get(key)).toBe('value-1');
    expect(await client.del(key)).toBe(1);
    expect(await client.get(key)).toBeNull();
  });

  it('reports the selected logical database index', async () => {
    // The guard already proved the index is non-zero; assert the client agrees.
    expect(index).toBeGreaterThan(0);
    expect(client.options.db).toBe(index);
  });

  it('bounds a ping with an explicit timeout', async () => {
    await expect(pingRedis(client, { timeoutMillis: 5_000 })).resolves.toBeUndefined();
  });

  it('expires a key with a TTL', async () => {
    const key = `tsms:integration:${process.pid}:ttl`;
    await client.set(key, 'temporary', 'EX', 30);
    expect(await client.ttl(key)).toBeGreaterThan(0);
    expect(await client.get(key)).toBe('temporary');
    await client.del(key);
  });

  it('flushes only the test logical database, leaving the default database intact', async () => {
    const other = createRedisClient('redis://:tsms_local_redis@127.0.0.1:6379');
    try {
      // Not part of this suite's contract with the developer, but it proves the
      // flush below is scoped: a key on database 0 survives FLUSHDB on database 1.
      await other.set('tsms:flush-scope-check', 'intact', 'EX', 30);
      await expect(client.flushdb()).resolves.toBe('OK');
      expect(await other.get('tsms:flush-scope-check')).toBe('intact');
      await other.del('tsms:flush-scope-check');
    } finally {
      await closeRedis(other);
    }
  });

  it('closes the connection and tolerates a second close', async () => {
    const disposable = createRedisClient(process.env.TEST_REDIS_URL);
    await pingRedis(disposable, { timeoutMillis: 5_000 });
    await closeRedis(disposable);
    // After shutdown the client must no longer serve commands. Assert the
    // observable contract rather than ioredis's internal status string, which
    // settles asynchronously after QUIT completes.
    await expect(disposable.get('tsms:integration:after-close')).rejects.toBeDefined();
    await expect(closeRedis(disposable)).resolves.toBeUndefined();
  });

  it('reports an unreachable Redis as a failure rather than succeeding', async () => {
    const unreachable = createRedisClient(process.env.TEST_REDIS_URL.replace('6379', '6380'), {
      connectTimeoutMillis: 2_000,
    });
    try {
      await expect(pingRedis(unreachable, { timeoutMillis: 3_000 })).rejects.toBeDefined();
    } finally {
      await closeRedis(unreachable);
    }
  });
});
