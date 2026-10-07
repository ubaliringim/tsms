import { describe, expect, it } from 'vitest';
import { assertDisposableTestDatabase, databaseNameOf } from '../dist/testing.js';

describe('integration test database safety', () => {
  it('accepts a loopback database whose name is explicitly marked as a test database', () => {
    const url = 'postgresql://tsms:secret@127.0.0.1:5432/tsms_test';
    expect(assertDisposableTestDatabase(url)).toBe(url);
    expect(databaseNameOf(url)).toBe('tsms_test');
  });

  it.each([
    ['the application development database', 'postgresql://tsms:secret@127.0.0.1:5432/tsms'],
    [
      'a database whose name merely contains "test"',
      'postgresql://tsms:secret@127.0.0.1:5432/my_test_data',
    ],
    ['a database with no name', 'postgresql://tsms:secret@127.0.0.1:5432'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertDisposableTestDatabase(url)).toThrow(
      'Refusing to run database integration tests',
    );
    expect(() => assertDisposableTestDatabase(url)).toThrow('No connection was opened');
  });

  it('refuses a test database on a remote host even when the name is correct', () => {
    expect(() =>
      assertDisposableTestDatabase('postgresql://tsms:secret@db.example.com:5432/tsms_test'),
    ).toThrow('host must be a loopback address');
  });

  it.each([
    ['a non-PostgreSQL URL', 'mysql://tsms:secret@127.0.0.1:3306/tsms_test'],
    ['unparseable input', 'definitely not a url'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertDisposableTestDatabase(url)).toThrow(
      'Refusing to run database integration tests',
    );
  });

  it('never repeats the supplied URL, which carries a password', () => {
    try {
      assertDisposableTestDatabase('postgresql://tsms:hunter2@db.example.com:5432/tsms_test');
      expect.unreachable('expected the guard to reject a remote host');
    } catch (error) {
      expect(error.message).not.toContain('hunter2');
      expect(error.message).not.toContain('db.example.com');
    }
  });
});
