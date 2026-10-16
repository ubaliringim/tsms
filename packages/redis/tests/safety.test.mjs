import { describe, expect, it } from 'vitest';
import { assertDisposableTestRedis, redisDatabaseIndexOf } from '../dist/testing.js';

describe('integration test Redis safety', () => {
  it('accepts a non-zero logical database', () => {
    const url = 'redis://:secret@127.0.0.1:6379/1';
    expect(assertDisposableTestRedis(url)).toBe(url);
    expect(redisDatabaseIndexOf(url)).toBe(1);
  });

  it('treats a URL without a path as the default database 0 and refuses it', () => {
    expect(redisDatabaseIndexOf('redis://:secret@127.0.0.1:6379')).toBe(0);
    expect(() => assertDisposableTestRedis('redis://:secret@127.0.0.1:6379')).toThrow(
      'must select a non-zero logical database',
    );
    expect(() => assertDisposableTestRedis('redis://:secret@127.0.0.1:6379/0')).toThrow(
      'must select a non-zero logical database',
    );
  });

  it('refuses a non-numeric or non-Redis URL', () => {
    expect(() => assertDisposableTestRedis('redis://:secret@127.0.0.1:6379/test')).toThrow(
      'must be a numeric index',
    );
    expect(() => assertDisposableTestRedis('http://127.0.0.1:6379/1')).toThrow(
      'must be a Redis URL',
    );
    expect(() => assertDisposableTestRedis('nonsense')).toThrow(
      'Refusing to run Redis integration tests',
    );
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts the loopback host %s', (host) => {
    const url = `redis://:secret@${host}:6379/1`;
    expect(assertDisposableTestRedis(url)).toBe(url);
  });

  it.each(['redis.internal.example.net', '10.0.0.5', '203.0.113.7', '0.0.0.0'])(
    'refuses the non-loopback host %s, because the tests delete keys in this database',
    (host) => {
      expect(() => assertDisposableTestRedis(`redis://:hunter2@${host}:6379/1`)).toThrow(
        'the host must be a loopback address',
      );
      try {
        assertDisposableTestRedis(`redis://:hunter2@${host}:6379/1`);
      } catch (error) {
        expect(error.message).not.toContain('hunter2');
        expect(error.message).not.toContain(host);
      }
    },
  );

  it('checks the logical database before the host, so the first refusal is unchanged', () => {
    expect(() =>
      assertDisposableTestRedis('redis://:secret@redis.internal.example.net:6379'),
    ).toThrow('must select a non-zero logical database');
  });

  it('never repeats the supplied URL, which carries a password', () => {
    try {
      assertDisposableTestRedis('redis://:hunter2@127.0.0.1:6379');
      expect.unreachable('expected the guard to reject database 0');
    } catch (error) {
      expect(error.message).not.toContain('hunter2');
    }
  });
});
