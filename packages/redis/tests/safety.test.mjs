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

  it('never repeats the supplied URL, which carries a password', () => {
    try {
      assertDisposableTestRedis('redis://:hunter2@127.0.0.1:6379');
      expect.unreachable('expected the guard to reject database 0');
    } catch (error) {
      expect(error.message).not.toContain('hunter2');
    }
  });
});
