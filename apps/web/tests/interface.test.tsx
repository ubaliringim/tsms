import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthClient } from '../src/client/auth-client';
import { LoginForm, loginMessage } from '../app/login-form';
import { SessionGate } from '../app/session-gate';

const never = (): never => {
  throw new Error('no request may be made while rendering');
};
const inert: AuthClient = { restore: never, login: never, logout: never };

describe('first render', () => {
  it('shows only a neutral status before the session has been checked', () => {
    // The static HTML is what a visitor sees before any script runs, so it must carry no identity,
    // no sign-in form to autofill, and no authenticated shell.
    const html = renderToStaticMarkup(<SessionGate client={inert} />);
    expect(html).toContain('Checking your session');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/Sign out|Signed in|<form|<input|Welcome/);
  });
});

describe('login form', () => {
  const html = renderToStaticMarkup(
    <LoginForm onSubmit={async () => ({ kind: 'rejected' })} notice={null} />,
  );

  it('labels both fields and submits by POST, so a native submit could never put credentials in a URL', () => {
    const ids = [...html.matchAll(/<label for="([^"]+)">(Email|Password)</g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
  });

  it('has a submit control and a live error region that starts hidden', () => {
    expect(html).toContain('type="submit"');
    expect(html).toMatch(/role="alert"[^>]*hidden/);
  });

  it('shows a notice politely when one is passed', () => {
    const noticed = renderToStaticMarkup(
      <LoginForm
        onSubmit={async () => ({ kind: 'rejected' })}
        notice="You have been signed out."
      />,
    );
    expect(noticed).toContain('role="status"');
    expect(noticed).toContain('You have been signed out.');
  });
});

describe('login messages', () => {
  it('give no signal about whether an account exists', () => {
    const rejected = loginMessage({ kind: 'rejected' });
    expect(rejected).toBe('The email or password is incorrect.');
    // One message covers an unknown address, a wrong password, and a disabled account.
    expect(rejected).not.toMatch(/exist|found|disabled|locked|registered|account/i);
  });

  it('distinguish refusal from outage without leaking detail', () => {
    expect(loginMessage({ kind: 'rate-limited', retryAfterSeconds: 30 })).toMatch(
      /Too many attempts/,
    );
    expect(loginMessage({ kind: 'unavailable' })).toMatch(/temporarily unavailable/);
    expect(loginMessage({ kind: 'invalid-input' })).toMatch(/Check/);
  });
});

describe('browser-side hygiene', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'api' && name !== 'server') walk(path);
      } else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(join(import.meta.dirname, '..', 'app'));
  walk(join(import.meta.dirname, '..', 'src'));

  it('inspects the browser-side sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('never persists authentication state or logs in browser code', () => {
    for (const file of files) {
      // Comments may name the very things the code avoids, so only code is checked.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(source, file).not.toMatch(/console\.\w+/);
      expect(source, file).not.toMatch(/NEXT_PUBLIC_/);
    }
  });
});
