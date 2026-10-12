import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVELOPMENT_API_ORIGIN, resolveApiOrigin } from '../src/server/api-origin';

describe('resolveApiOrigin', () => {
  it('falls back to the loopback API only outside production', () => {
    expect(resolveApiOrigin({ NODE_ENV: 'development' })).toBe(DEFAULT_DEVELOPMENT_API_ORIGIN);
    expect(resolveApiOrigin({ NODE_ENV: 'test', TSMS_API_ORIGIN: '  ' })).toBe(
      DEFAULT_DEVELOPMENT_API_ORIGIN,
    );
    expect(resolveApiOrigin({})).toBe(DEFAULT_DEVELOPMENT_API_ORIGIN);
  });

  it('refuses to start production on a development default', () => {
    expect(resolveApiOrigin({ NODE_ENV: 'production' })).toBeNull();
    expect(resolveApiOrigin({ NODE_ENV: 'production', TSMS_API_ORIGIN: '' })).toBeNull();
  });

  it('accepts a configured http(s) origin and normalises a trailing slash', () => {
    expect(
      resolveApiOrigin({ NODE_ENV: 'production', TSMS_API_ORIGIN: 'https://api.example.test' }),
    ).toBe('https://api.example.test');
    expect(resolveApiOrigin({ TSMS_API_ORIGIN: 'http://127.0.0.1:4100/' })).toBe(
      'http://127.0.0.1:4100',
    );
  });

  it('requires HTTPS for a non-loopback upstream in production, but not in development', () => {
    expect(
      resolveApiOrigin({ NODE_ENV: 'production', TSMS_API_ORIGIN: 'http://api.internal.test' }),
    ).toBeNull();
    expect(
      resolveApiOrigin({ NODE_ENV: 'production', TSMS_API_ORIGIN: 'http://127.0.0.1:4000' }),
    ).toBe('http://127.0.0.1:4000');
    expect(
      resolveApiOrigin({ NODE_ENV: 'development', TSMS_API_ORIGIN: 'http://api.internal.test' }),
    ).toBe('http://api.internal.test');
  });

  it.each([
    'not a url',
    'ftp://api.example.test',
    'javascript:alert(1)',
    'https://user:secret@api.example.test',
    'https://api.example.test/auth',
    'https://api.example.test/?x=1',
    'https://api.example.test/#frag',
    'https://api.example.test:443',
  ])('rejects %s', (value) => {
    expect(resolveApiOrigin({ NODE_ENV: 'development', TSMS_API_ORIGIN: value })).toBeNull();
  });
});
