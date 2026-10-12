/**
 * Stage 2.7 regression tests for failures that were found the hard way.
 *
 * - A type-only import used for constructor injection made Nest record `Function` as the parameter type,
 *   so the guard could not be resolved, and with the logger disabled the process aborted with no output.
 * - Integration tests ran against a stale `dist` and reported green for code they never loaded.
 * - The unknown-error path of the exception filter had no test, although it is the one place an arbitrary
 *   thrown value meets a public response.
 */

import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distDrift } from './support/dist-freshness.mjs';
import { startupFailure } from '../dist/application.js';
import { AuthController } from '../dist/identity/auth.controller.js';
import { AuthAbuseGuard } from '../dist/identity/auth-abuse.guard.js';
import { AbuseReservationInterceptor } from '../dist/identity/abuse-reservation.interceptor.js';
import { TrustedOriginGuard } from '../dist/identity/trusted-origin.guard.js';
import { SafeHttpExceptionFilter } from '../dist/identity/auth-exception.filter.js';
import { SecurityLog } from '../dist/identity/security-log.js';

/**
 * Parameters whose injection token Nest cannot read.
 *
 * `Object` and `Function` are what the compiler emits when a parameter's type was erased (a type-only
 * import, an interface, a union). A parameter marked with `@Inject(token)` does not rely on its type, so
 * it is exempt.
 */
function unresolvableParameters(target) {
  const types = Reflect.getMetadata('design:paramtypes', target) ?? [];
  const explicit = new Set(
    (Reflect.getMetadata('self:paramtypes', target) ?? []).map((entry) => entry.index),
  );
  return types
    .map((type, index) => ({ type, index }))
    .filter(({ type, index }) => !explicit.has(index) && (type === Object || type === Function))
    .map(({ index }) => index);
}

describe('dependency injection metadata', () => {
  it.each([
    ['AuthController', AuthController],
    ['AuthAbuseGuard', AuthAbuseGuard],
    ['AbuseReservationInterceptor', AbuseReservationInterceptor],
    ['TrustedOriginGuard', TrustedOriginGuard],
  ])('%s has an injectable type for every constructor parameter', (_name, target) => {
    expect(unresolvableParameters(target)).toEqual([]);
  });

  it('records the real SecurityLog class for the abuse guard, not an erased placeholder', () => {
    // The Stage 2.7 startup failure, pinned directly: a type-only import would make this `Function`.
    const types = Reflect.getMetadata('design:paramtypes', AuthAbuseGuard);
    expect(types).toContain(SecurityLog);
  });

  it('the checker itself flags an erased parameter', () => {
    // Negative control for the check above: a class compiled as if its import had been type-only.
    class Erased {}
    Reflect.defineMetadata('design:paramtypes', [Function, SecurityLog], Erased);
    expect(unresolvableParameters(Erased)).toEqual([0]);
    Reflect.defineMetadata('self:paramtypes', [{ index: 0, param: 'TOKEN' }], Erased);
    expect(unresolvableParameters(Erased)).toEqual([]);
  });
});

describe('startup failure reporting', () => {
  it('names the missing dependency for a Nest resolution error', () => {
    class UnknownDependenciesException extends Error {}
    const reported = startupFailure(
      new UnknownDependenciesException(
        'Nest cannot resolve dependencies of the AuthAbuseGuard (?)',
      ),
    );
    expect(reported.message).toContain('AuthAbuseGuard');
  });

  it('reduces every other error to its class name, so a connection secret cannot be printed', () => {
    const reported = startupFailure(
      new Error('connect failed: postgresql://user:hunter2-secret@127.0.0.1:5432/db'),
    );
    expect(reported.message).not.toContain('hunter2-secret');
    expect(reported.message).not.toContain('postgresql');
    expect(reported.message).toContain('API startup failed');
  });

  it('copes with a thrown value that is not an Error', () => {
    expect(startupFailure('postgresql://u:p@h/d').message).not.toContain('postgresql');
  });
});

describe('unexpected errors are answered with a constant body and a sanitised log line', () => {
  function respond(exception) {
    const records = [];
    const log = new SecurityLog({ sink: (record) => records.push(record) });
    const filter = new SafeHttpExceptionFilter({ reply() {}, isHeadersSent: () => false }, log);
    let sent;
    const response = {
      status(code) {
        sent = { code };
        return response;
      },
      json(body) {
        sent.body = body;
      },
    };
    filter.catch(exception, {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    });
    return { sent, records };
  }

  it('does not echo the message of an arbitrary Error', () => {
    const { sent, records } = respond(new Error('password=hunter2 and token=abc'));
    expect(sent).toEqual({
      code: 500,
      body: { statusCode: 500, message: 'Internal server error' },
    });
    expect(JSON.stringify(records)).not.toContain('hunter2');
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('unhandled_request_error');
  });

  it('does not echo the message of an object shaped like an HTTP error', () => {
    // The framework default would put this message in the response.
    const { sent, records } = respond({ statusCode: 502, message: 'upstream said: s3cret-value' });
    expect(JSON.stringify(sent)).not.toContain('s3cret-value');
    expect(JSON.stringify(records)).not.toContain('s3cret-value');
  });

  it('logs only allowlisted fields, whatever the exception carries', () => {
    const error = Object.assign(new Error('boom'), {
      stack: 'at secret/path',
      cause: 'cookie=abc',
      sql: 'select',
    });
    const { records } = respond(error);
    expect(
      Object.keys(records[0]).every((key) => ['kind', 'requestId', 'reason'].includes(key)),
    ).toBe(true);
  });
});

describe('the stale-build guard', () => {
  function tree() {
    const root = mkdtempSync(join(tmpdir(), 'tsms-dist-guard-'));
    const src = join(root, 'src');
    const dist = join(root, 'dist');
    mkdirSync(join(src, 'sub'), { recursive: true });
    mkdirSync(join(dist, 'sub'), { recursive: true });
    return { root, src, dist };
  }
  const touch = (file, seconds) => {
    writeFileSync(file, '');
    utimesSync(file, seconds, seconds);
  };

  it('accepts output that is at least as new as its source', () => {
    const { root, src, dist } = tree();
    try {
      touch(join(src, 'a.ts'), 100);
      touch(join(src, 'sub', 'b.ts'), 100);
      touch(join(dist, 'a.js'), 100);
      touch(join(dist, 'sub', 'b.js'), 200);
      expect(distDrift(src, dist)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a stale, a missing, and an orphaned file', () => {
    const { root, src, dist } = tree();
    try {
      touch(join(src, 'stale.ts'), 200);
      touch(join(dist, 'stale.js'), 100);
      touch(join(src, 'missing.ts'), 100);
      touch(join(dist, 'orphan.js'), 100);
      const problems = distDrift(src, dist);
      expect(problems).toContain('stale: stale.ts');
      expect(problems).toContain('not compiled: missing.ts');
      expect(problems).toContain('orphaned: orphan.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports nested paths with forward slashes on every platform', () => {
    const { root, src, dist } = tree();
    try {
      touch(join(src, 'sub', 'deep.ts'), 200);
      touch(join(dist, 'sub', 'deep.js'), 100);
      touch(join(dist, 'sub', 'gone.js'), 100);
      const problems = distDrift(src, dist);
      expect(problems).toContain('stale: sub/deep.ts');
      expect(problems).toContain('orphaned: sub/gone.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores declaration files in source and accepts a file exactly as new as its source', () => {
    const { root, src, dist } = tree();
    try {
      touch(join(src, 'types.d.ts'), 100);
      touch(join(src, 'a.ts'), 100);
      touch(join(dist, 'a.js'), 100);
      expect(distDrift(src, dist)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a missing dist outright', () => {
    expect(distDrift('.', join(tmpdir(), 'tsms-no-such-dist'))).toEqual(['dist is missing']);
  });
});
