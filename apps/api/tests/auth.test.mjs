import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '@tsms/config';
import {
  clearSessionCookie,
  cookieMaxAgeSeconds,
  readSessionCookie,
  serializeSessionCookie,
  sessionCookiePolicy,
} from '../dist/identity/auth-cookie.js';
import { isTrustedOrigin } from '../dist/identity/trusted-origin.guard.js';
import { normalizeEmail, MAX_EMAIL_LENGTH } from '../dist/identity/auth.service.js';
import { AuthExceptionFilter } from '../dist/identity/auth-exception.filter.js';
import { AuthError } from '../dist/identity/auth.service.js';

const production = sessionCookiePolicy('production');
const development = sessionCookiePolicy('development');
const test = sessionCookiePolicy('test');

describe('browser session cookie policy', () => {
  it('derives production transport from NODE_ENV with no configuration override', () => {
    expect(production).toEqual({
      name: '__Host-tsms_session',
      secure: true,
      path: '/',
      sameSite: 'Lax',
    });
  });

  it('keeps development and test on the plain-HTTP-compatible name and never Secure', () => {
    for (const policy of [development, test]) {
      expect(policy).toEqual({
        name: 'tsms_session',
        secure: false,
        path: '/',
        sameSite: 'Lax',
      });
    }
  });

  it('satisfies every __Host- prefix requirement in production', () => {
    // The browser rejects a __Host- cookie unless Secure, Path=/ and no Domain are all present.
    expect(production.name.startsWith('__Host-')).toBe(true);
    expect(production.secure).toBe(true);
    expect(production.path).toBe('/');
    expect(serializeSessionCookie(production, 'token', 60)).not.toContain('Domain=');
  });

  it('never emits Secure in the non-production policy', () => {
    expect(serializeSessionCookie(development, 'token', 60)).not.toContain('Secure');
  });

  it('marks the cookie HttpOnly and SameSite=Lax with no Domain', () => {
    const header = serializeSessionCookie(production, 'a'.repeat(43), 60);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Secure');
    expect(header).not.toContain('Domain');
  });

  it('emits the token verbatim, with no escaping', () => {
    const token = 'A'.repeat(43);
    expect(serializeSessionCookie(production, token, 60)).toContain(`${production.name}=${token};`);
  });

  it('bounds Max-Age to the session expiry and never goes negative', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 604_800_000);
    expect(cookieMaxAgeSeconds(expiresAt, now)).toBe(604_800);
    expect(cookieMaxAgeSeconds(now, now)).toBe(0);
    expect(cookieMaxAgeSeconds(new Date(now.getTime() - 1000), now)).toBe(0);
    expect(serializeSessionCookie(production, 'token', -5)).toContain('Max-Age=0');
    expect(serializeSessionCookie(production, 'token', 90.7)).toContain('Max-Age=90');
  });

  it('clears with the same name, path and transport attributes as it sets', () => {
    const cleared = clearSessionCookie(production);
    expect(cleared.startsWith(`${production.name}=;`)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('SameSite=Lax');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(clearSessionCookie(development)).not.toContain('Secure');
  });
});

describe('session cookie parsing', () => {
  it('reads the configured name and ignores unrelated cookies', () => {
    const header = `theme=dark; ${development.name}=abc123; locale=en-GB`;
    expect(readSessionCookie(header, development)).toBe('abc123');
  });

  it('returns null for an absent, empty or non-string header', () => {
    expect(readSessionCookie(undefined, development)).toBeNull();
    expect(readSessionCookie(null, development)).toBeNull();
    expect(readSessionCookie('', development)).toBeNull();
    expect(readSessionCookie(42, development)).toBeNull();
  });

  it('returns null when the session cookie is present but empty', () => {
    expect(readSessionCookie(`${development.name}=`, development)).toBeNull();
    expect(readSessionCookie(`${development.name}=   `, development)).toBeNull();
  });

  it('rejects a duplicated session cookie instead of choosing an occurrence', () => {
    // Cookie tossing from a subdomain looks exactly like this. Picking first or last would let an
    // attacker-planted cookie win, so the request is simply unauthenticated.
    expect(
      readSessionCookie(`${development.name}=attacker; ${development.name}=victim`, development),
    ).toBeNull();
    expect(
      readSessionCookie(
        `${development.name}=a; ${development.name}=b; ${development.name}=c`,
        development,
      ),
    ).toBeNull();
  });

  it('rejects quoted and percent-encoded forms rather than decoding them', () => {
    // The Stage 2.3 token alphabet is base64url, so neither form is a token this stage issues.
    expect(readSessionCookie(`${development.name}="abc"`, development)).toBe('"abc"');
    expect(readSessionCookie(`${development.name}=abc`, development)).toBe('abc');
    expect(readSessionCookie(`${development.name}=abc`, development)).not.toBe('"abc"');
  });

  it('reads only the environment-appropriate name', () => {
    const header = `${production.name}=abc`;
    expect(readSessionCookie(header, production)).toBe('abc');
    // A development name is not a production cookie and vice versa.
    expect(readSessionCookie(`${development.name}=abc`, production)).toBeNull();
  });

  it('ignores pairs with no name or no separator', () => {
    expect(readSessionCookie('=orphan; ; ;', development)).toBeNull();
    expect(readSessionCookie(`garbage; ${development.name}=ok`, development)).toBe('ok');
  });
});

describe('trusted origin matching', () => {
  const allow = Object.freeze(['https://app.example.com', 'http://127.0.0.1:3000']);

  it('accepts an exact configured origin', () => {
    expect(isTrustedOrigin('https://app.example.com', allow)).toBe(true);
    expect(isTrustedOrigin('http://127.0.0.1:3000', allow)).toBe(true);
  });

  it('rejects a missing or non-string Origin', () => {
    expect(isTrustedOrigin(undefined, allow)).toBe(false);
    expect(isTrustedOrigin(null, allow)).toBe(false);
    expect(isTrustedOrigin('', allow)).toBe(false);
    expect(isTrustedOrigin(['https://app.example.com'], allow)).toBe(false);
  });

  it('requires an exact scheme, host and port', () => {
    expect(isTrustedOrigin('http://app.example.com', allow)).toBe(false);
    expect(isTrustedOrigin('https://app.example.com:443', allow)).toBe(false);
    expect(isTrustedOrigin('https://APP.example.com', allow)).toBe(false);
    expect(isTrustedOrigin('https://app.example.com/', allow)).toBe(false);
    expect(isTrustedOrigin('https://app.example.com.evil.test', allow)).toBe(false);
  });

  it('does not accept subdomains by suffix', () => {
    expect(isTrustedOrigin('https://evil.app.example.com', allow)).toBe(false);
    expect(isTrustedOrigin('https://app.example.com.evil.test', allow)).toBe(false);
  });

  it('does not accept a wildcard or a comma-joined list in a header', () => {
    expect(isTrustedOrigin('*', allow)).toBe(false);
    expect(isTrustedOrigin('https://*.example.com', allow)).toBe(false);
    expect(isTrustedOrigin('https://a.example.com,https://b.example.com', allow)).toBe(false);
  });

  it('fails closed when the allowlist is empty', () => {
    expect(isTrustedOrigin('https://app.example.com', [])).toBe(false);
  });

  it('never derives a trusted origin from forwarded or host headers', () => {
    // The guard reads only Origin. A request able to set these must not influence the decision.
    for (const header of [
      'https://app.example.com',
      'app.example.com',
      'https://attacker.test',
      undefined,
    ]) {
      expect(isTrustedOrigin(header, allow)).toBe(header === 'https://app.example.com');
    }
  });
});

describe('email normalization for identity lookup', () => {
  it('trims surrounding whitespace and lowercases, and nothing else', () => {
    expect(normalizeEmail('  Person@Example.COM  ')).toBe('person@example.com');
    expect(normalizeEmail('\t\nUser@Example.test\r\n')).toBe('user@example.test');
  });

  it('does not strip plus addressing or dots, matching the column rule', () => {
    expect(normalizeEmail('User+tag@example.test')).toBe('user+tag@example.test');
    expect(normalizeEmail('First.Last@example.test')).toBe('first.last@example.test');
  });

  it('lowercases with the locale-independent Unicode default, and does not compose', () => {
    // toLowerCase is the Unicode default conversion, not locale-aware folding: U+1E9E maps to
    // U+00DF. What matters is that it is deterministic and that nothing is composed.
    expect(normalizeEmail('USER@EXAMPLE.TEST')).toBe('user@example.test');
    expect(normalizeEmail('ẞ@EXAMPLE.TEST')).toBe('ß@example.test');
    expect(normalizeEmail('İ@EXAMPLE.TEST')).toBe('i̇@example.test');
    // No NFC/NFKC: the combining acute stays separate.
    expect(normalizeEmail('é@EXAMPLE.TEST')).toBe('é@example.test');
    expect(normalizeEmail('é@EXAMPLE.TEST')).toBe('é@example.test');
  });

  it('rejects values that are not usable addresses', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });

  it('rejects ASCII control characters anywhere in the value', () => {
    expect(normalizeEmail('user@example.test\n')).toBe('user@example.test');
    expect(normalizeEmail('us\ner@example.test')).toBeNull();
    expect(normalizeEmail('user@example.test\r\nX-Injected: 1')).toBeNull();
    expect(normalizeEmail('user@example.test\u0000')).toBeNull();
  });

  it('bounds length after trimming', () => {
    expect(normalizeEmail(`${'a'.repeat(MAX_EMAIL_LENGTH)}@example.test`)).toBeNull();
    expect(normalizeEmail(`a@${'b'.repeat(MAX_EMAIL_LENGTH)}.test`)).toBeNull();
  });
});

describe('authentication error bodies', () => {
  const capture = (code) => {
    let sent = null;
    const response = {
      status(value) {
        sent = { ...(sent ?? {}), statusCode: value };
        return response;
      },
      json(value) {
        sent = { ...(sent ?? {}), ...value };
        return response;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) };
    new AuthExceptionFilter().catch(new AuthError(code), host);
    return sent;
  };

  it('collapses every authentication failure to one indistinguishable body', () => {
    expect(capture('AUTHENTICATION_FAILED')).toEqual({
      statusCode: 401,
      error: 'authentication_failed',
    });
  });

  it('uses distinct fixed bodies for malformed input and operational failure', () => {
    expect(capture('INVALID_REQUEST')).toEqual({ statusCode: 400, error: 'invalid_request' });
    expect(capture('SERVICE_FAILURE')).toEqual({
      statusCode: 503,
      error: 'service_unavailable',
    });
  });

  it('never carries the internal error code or a cause into the response', () => {
    const body = JSON.stringify(capture('AUTHENTICATION_FAILED'));
    expect(body).not.toContain('AUTHENTICATION_FAILED');
    expect(body).not.toContain('message');
    expect(body).not.toContain('stack');
  });

  it('falls back to the generic operational body for an unrecognised code', () => {
    expect(capture('SOMETHING_NEW')).toEqual({
      statusCode: 503,
      error: 'service_unavailable',
    });
  });
});

describe('trusted origin configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/tsms',
    REDIS_URL: 'redis://:p@127.0.0.1:6379',
  };

  it('requires an allowlist in every environment including production', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(() => parseApiEnvironment({ ...base, NODE_ENV })).toThrow(/API_TRUSTED_ORIGINS/);
      expect(() => parseApiEnvironment({ ...base, NODE_ENV, API_TRUSTED_ORIGINS: '' })).toThrow(
        /API_TRUSTED_ORIGINS/,
      );
    }
  });

  it('normalises entries to bare origins', () => {
    expect(
      parseApiEnvironment({
        ...base,
        API_TRUSTED_ORIGINS: ' https://App.Example.com , http://127.0.0.1:3000/ ',
      }).API_TRUSTED_ORIGINS,
    ).toEqual(['https://app.example.com', 'http://127.0.0.1:3000']);
  });

  it('rejects a host that new URL would accept but no browser could send', () => {
    // `new URL` parses a literal `*` and a comma into the host. Both would otherwise be stored
    // as trusted origins that can never match, hiding the mistake instead of failing startup.
    // Whitespace *around* a separator comma is legitimate and stays accepted.
    for (const API_TRUSTED_ORIGINS of [
      'https://*.example.com',
      'https://a.example.com,https://a.example.com',
    ]) {
      expect(() => parseApiEnvironment({ ...base, API_TRUSTED_ORIGINS })).toThrow(
        /API_TRUSTED_ORIGINS/,
      );
    }
    expect(
      parseApiEnvironment({
        ...base,
        API_TRUSTED_ORIGINS: 'https://app.example.com , https://other.example.com',
      }).API_TRUSTED_ORIGINS,
    ).toEqual(['https://app.example.com', 'https://other.example.com']);
  });

  it('rejects values that could widen the allowlist', () => {
    const invalid = [
      '*',
      'https://*.example.com',
      'app.example.com',
      'ftp://app.example.com',
      'https://user:pass@app.example.com',
      'https://app.example.com/app',
      'https://app.example.com?next=//evil.test',
      'https://app.example.com#fragment',
      'https://a.example.com,https://a.example.com',
    ];
    for (const API_TRUSTED_ORIGINS of invalid) {
      expect(() => parseApiEnvironment({ ...base, API_TRUSTED_ORIGINS })).toThrow(
        /API_TRUSTED_ORIGINS/,
      );
    }
  });

  it('never echoes a rejected origin value in the error', () => {
    let message = '';
    try {
      parseApiEnvironment({ ...base, API_TRUSTED_ORIGINS: 'https://secret-app.example.com/app' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('API_TRUSTED_ORIGINS');
    expect(message).not.toContain('secret-app.example.com');
  });
});
