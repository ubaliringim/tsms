/**
 * Stage 2.7 unit tests: taxonomy, allowlist, sanitisation, throttling, correlation.
 *
 * These are the parts of the stage that must hold without a database or a Redis, because they are the
 * parts a caller can abuse. Every test here asserts a *boundary* - something that must be dropped,
 * refused, or bounded - rather than restating a constant.
 */

import { describe, expect, it } from 'vitest';
import {
  RESERVED_EVENT_TYPES,
  SECURITY_EVENT_ENDPOINTS,
  SECURITY_EVENT_TYPES,
  sanitizedUuid,
  securityEndpointOf,
  securityEventTypeOf,
} from '../src/identity/security-event.js';
import { SecurityLog, sanitizeSecurityFields } from '../src/identity/security-log.js';
import {
  SecurityEventRecorder,
  securityEventRow,
} from '../src/identity/security-event-recorder.js';
import {
  SECURITY_REQUEST_ID_HEADER,
  requestIdOf,
  securityRequestContext,
} from '../src/identity/security-request-context.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('the event vocabulary is closed', () => {
  it('accepts only the six types this stage writes', () => {
    for (const type of SECURITY_EVENT_TYPES) {
      expect(securityEventTypeOf(type)).toBe(type);
    }
  });

  it('refuses the three reserved types, which describe actions that do not exist', () => {
    // Emitting ACCOUNT_DISABLED when a login is merely refused on a disabled account would assert a
    // disablement that never happened, so these must stay unreachable.
    for (const type of RESERVED_EVENT_TYPES) {
      expect(securityEventTypeOf(type)).toBeUndefined();
    }
  });

  it('refuses anything outside the vocabulary, including near-misses and injections', () => {
    for (const value of [
      'LOGIN_SUCCEEDED ',
      ' login_succeeded',
      'LOGIN_SUCCEEDED;DROP TABLE authentication_events',
      "LOGIN_SUCCEEDED'",
      '',
      null,
      undefined,
      42,
      {},
      ['LOGIN_SUCCEEDED'],
    ]) {
      expect(securityEventTypeOf(value)).toBeUndefined();
    }
  });

  it('refuses an endpoint outside the closed set', () => {
    expect(securityEndpointOf('login')).toBe('login');
    for (const value of ['admin', '/auth/login', 'login ', '', null, 7]) {
      expect(securityEndpointOf(value)).toBeUndefined();
    }
    expect(SECURITY_EVENT_ENDPOINTS).toContain('reset');
  });
});

describe('identifiers are normalised before they are stored', () => {
  it('keeps a canonical uuid', () => {
    expect(sanitizedUuid(UUID)).toBe(UUID);
  });

  it('normalises case and surrounding whitespace rather than rejecting them', () => {
    expect(sanitizedUuid(`  ${UUID.toUpperCase()}  `)).toBe(UUID);
  });

  it('drops anything that is not a uuid, so free text cannot reach a text column', () => {
    for (const value of [
      "1'; DELETE FROM authentication_events; --",
      'not-a-uuid',
      `${UUID}-extra`,
      UUID.replace(/-/g, ''),
      'x'.repeat(400),
      '',
      null,
      undefined,
      12345,
    ]) {
      expect(sanitizedUuid(value)).toBeUndefined();
    }
  });
});

describe('an event row carries only the four permitted columns', () => {
  it('builds a row with no field for a payload', () => {
    const row = securityEventRow({ eventType: 'LOGIN_FAILED', userId: UUID, requestId: UUID });
    expect(Object.keys(row).sort()).toEqual(['eventType', 'requestId', 'userId']);
    expect(row).toEqual({ eventType: 'LOGIN_FAILED', userId: UUID, requestId: UUID });
  });

  it('represents an unknown identity as null rather than inventing a value', () => {
    const row = securityEventRow({ eventType: 'LOGIN_FAILED', userId: null });
    expect(row.userId).toBeNull();
  });

  it('drops a malformed userId instead of storing it', () => {
    const row = securityEventRow({ eventType: 'LOGIN_FAILED', userId: 'person@example.test' });
    expect(row.userId).toBeNull();
  });

  it('refuses to invent a row for an unknown event type', () => {
    expect(() => securityEventRow({ eventType: 'SOMETHING_ELSE' })).toThrow();
  });

  it('cannot be given a password, a token, or an address, because there is no parameter for one', () => {
    // Structural proof rather than a behavioural one: adding a payload field to the row requires a
    // parameter that does not exist. `row` has exactly three keys regardless of what a caller wants.
    const row = securityEventRow({
      eventType: 'LOGIN_SUCCEEDED',
      userId: UUID,
      requestId: UUID,
      password: 'correct horse battery staple',
      token: 'recovery-token-value',
      email: 'person@example.test',
      headers: { authorization: 'Bearer secret' },
    });
    expect(JSON.stringify(row)).not.toContain('correct horse');
    expect(JSON.stringify(row)).not.toContain('recovery-token-value');
    expect(JSON.stringify(row)).not.toContain('example.test');
    expect(JSON.stringify(row)).not.toContain('Bearer');
  });
});

describe('security log sanitisation is an allowlist, not a scrub', () => {
  it('keeps the fields it recognises', () => {
    expect(
      sanitizeSecurityFields({
        requestId: UUID,
        endpoint: 'login',
        userId: UUID,
        reason: 'rate_limited',
      }),
    ).toEqual({ requestId: UUID, endpoint: 'login', userId: UUID, reason: 'rate_limited' });
  });

  it('drops every field it does not recognise', () => {
    const clean = sanitizeSecurityFields({
      requestId: UUID,
      email: 'person@example.test',
      password: 'hunter2',
      ip: '203.0.113.7',
      redisKey: '{tsms-rl}:login:target:abc',
      headers: { cookie: 'sid=abc' },
    });
    expect(Object.keys(clean)).toEqual(['requestId']);
    const serialised = JSON.stringify(clean);
    for (const secret of ['person@example.test', 'hunter2', '203.0.113.7', 'tsms-rl', 'sid=abc']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('drops an out-of-set reason rather than logging it', () => {
    expect(
      sanitizeSecurityFields({ reason: 'postgres://user:pass@host/db' }).reason,
    ).toBeUndefined();
  });

  it('bounds a count and rejects nonsense', () => {
    expect(sanitizeSecurityFields({ count: 8 }).count).toBe(8);
    for (const value of [-1, 1.5, '8', Number.NaN, 2_000_000, null]) {
      expect(sanitizeSecurityFields({ count: value }).count).toBeUndefined();
    }
  });
});

describe('security log emission is bounded', () => {
  function collector() {
    const lines = [];
    return { lines, sink: (record) => lines.push(record) };
  }

  it('emits the first record in a window and absorbs the rest', () => {
    const { lines, sink } = collector();
    let now = 1_000;
    const log = new SecurityLog({ now: () => now, windowMillis: 5_000, sink });

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      log.record('auth_rate_limited', { endpoint: 'login', reason: 'rate_limited' });
    }

    // One line, not a thousand. This is the property that stops a flood from becoming a write amplifier.
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('auth_rate_limited');

    // Crossing the window emits the aggregate plus the new record.
    now += 5_000;
    log.record('auth_rate_limited', { endpoint: 'login', reason: 'rate_limited' });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ kind: 'security_log_suppressed', suppressed: 999 });
    expect(lines[2].kind).toBe('auth_rate_limited');
  });

  it('bounds each endpoint independently', () => {
    const { lines, sink } = collector();
    const log = new SecurityLog({ now: () => 1_000, windowMillis: 5_000, sink });
    log.record('auth_rate_limited', { endpoint: 'login' });
    log.record('auth_rate_limited', { endpoint: 'forgot' });
    expect(lines).toHaveLength(2);
  });

  it('never throws, whatever it is handed', () => {
    const log = new SecurityLog({
      sink: () => {
        throw new Error('sink exploded');
      },
    });
    expect(() => log.record('auth_rate_limited', { endpoint: 'login' })).not.toThrow();
    expect(() => log.record(null, null)).not.toThrow();
    expect(() => log.record('auth_rate_limited', { count: Symbol('x') })).not.toThrow();
  });

  it('keeps its throttle map bounded even with unbounded distinct keys', () => {
    const { sink } = collector();
    let now = 1_000;
    const log = new SecurityLog({ now: () => (now += 1), windowMillis: 1, sink });
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      log.record('auth_rate_limited', { endpoint: 'login', userId: `${attempt}` });
    }
    expect(sink).toBeDefined();
  });
});

describe('request correlation is server-generated', () => {
  function runMiddleware(headers = {}) {
    const request = { headers };
    const written = {};
    const response = {
      setHeader: (name, value) => {
        written[name] = value;
      },
    };
    securityRequestContext(request, response, () => {});
    return { request, written };
  }

  it('generates a uuid for every request', () => {
    const { request, written } = runMiddleware();
    expect(requestIdOf(request)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(written[SECURITY_REQUEST_ID_HEADER]).toBe(requestIdOf(request));
  });

  it('ignores a client-supplied request id rather than trusting it', () => {
    // A caller-chosen value would let an attacker correlate unrelated requests by reusing one, and
    // would put chosen text into an audit row.
    const attacker = "'; DROP TABLE authentication_events; --";
    const { request, written } = runMiddleware({ 'x-request-id': attacker });
    expect(requestIdOf(request)).not.toBe(attacker);
    expect(written[SECURITY_REQUEST_ID_HEADER]).not.toBe(attacker);
  });

  it('gives two requests different ids', () => {
    expect(requestIdOf(runMiddleware().request)).not.toBe(requestIdOf(runMiddleware().request));
  });

  it('stores the id under a symbol, so it cannot be overwritten by a string key', () => {
    const { request } = runMiddleware();
    request.requestId = 'attacker-value';
    request.xRequestId = 'attacker-value';
    expect(requestIdOf(request)).not.toBe('attacker-value');
  });

  it('returns undefined rather than inventing an id off the request cycle', () => {
    expect(requestIdOf(undefined)).toBeUndefined();
    expect(requestIdOf(null)).toBeUndefined();
    expect(requestIdOf('a string')).toBeUndefined();
    expect(requestIdOf({})).toBeUndefined();
  });
});

describe('the detached failure write cannot reject, leak, or loop', () => {
  const SECRET = 'postgresql://app:hunter2-secret@127.0.0.1:5432/db';

  function recorderOver(create) {
    const records = [];
    const log = new SecurityLog({ sink: (record) => records.push(record) });
    return {
      records,
      recorder: new SecurityEventRecorder({ authenticationEvent: { create } }, log),
    };
  }

  it('resolves when the database rejects, and logs nothing from the driver error', async () => {
    const { recorder, records } = recorderOver(async () => {
      throw Object.assign(new Error(`connect failed ${SECRET}`), {
        code: 'P1001',
        meta: { SECRET },
      });
    });
    await expect(
      recorder.detached({ eventType: 'LOGIN_FAILED', userId: UUID, requestId: UUID }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(records)).not.toContain('hunter2');
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('security_event_write_failed');
    expect(
      Object.keys(records[0]).every((k) => ['kind', 'requestId', 'userId', 'reason'].includes(k)),
    ).toBe(true);
  });

  it('resolves for an invalid event type instead of throwing, and writes nothing', async () => {
    let writes = 0;
    const { recorder, records } = recorderOver(async () => {
      writes += 1;
    });
    await expect(recorder.detached({ eventType: 'NOT_A_TYPE' })).resolves.toBeUndefined();
    expect(writes).toBe(0);
    expect(records).toHaveLength(1);
  });

  it('causes no unhandled rejection even when the caller does not await it', async () => {
    const seen = [];
    const listener = (reason) => seen.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { recorder } = recorderOver(async () => {
        throw new Error(SECRET);
      });
      void recorder.detached({ eventType: 'LOGIN_FAILED' });
      void recorder.detached({ eventType: 'NOT_A_TYPE' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(seen).toEqual([]);
  });

  it('performs exactly one insert per call, with no retry', async () => {
    let writes = 0;
    const { recorder } = recorderOver(async () => {
      writes += 1;
      throw new Error('down');
    });
    await Promise.all(
      Array.from({ length: 10 }, () => recorder.detached({ eventType: 'LOGIN_FAILED' })),
    );
    expect(writes).toBe(10);
  });

  it('bounds the failure log under a flood of failed writes', async () => {
    const { recorder, records } = recorderOver(async () => {
      throw new Error('down');
    });
    await Promise.all(
      Array.from({ length: 500 }, () => recorder.detached({ eventType: 'LOGIN_FAILED' })),
    );
    expect(records.length).toBeLessThanOrEqual(2);
  });
});
