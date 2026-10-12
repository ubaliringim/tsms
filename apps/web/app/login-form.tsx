'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import type { LoginOutcome } from '../src/client/auth-client';

/**
 * Every failure message here is deliberately generic. A rejected credential, an unknown address, and a
 * disabled account arrive as the same API answer, and this form must not add any signal of its own.
 */
export function loginMessage(outcome: Exclude<LoginOutcome, { kind: 'success' }>): string {
  switch (outcome.kind) {
    case 'rejected':
      return 'The email or password is incorrect.';
    case 'invalid-input':
      return 'Check the email and password you entered and try again.';
    case 'rate-limited':
      return 'Too many attempts. Wait a little while, then try again.';
    case 'unavailable':
      return 'Sign-in is temporarily unavailable. Try again shortly.';
  }
}

interface LoginFormProps {
  readonly onSubmit: (email: string, password: string) => Promise<LoginOutcome>;
  readonly notice: string | null;
}

export function LoginForm({ onSubmit, notice }: LoginFormProps) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setPending(true);
    setError(null);
    const outcome = await onSubmit(email, password);
    // Success unmounts this form; only a failure leaves it on screen.
    if (outcome.kind === 'success') return;
    setError(loginMessage(outcome));
    // The password never lingers in the field after an attempt.
    if (passwordRef.current) passwordRef.current.value = '';
    setPending(false);
    passwordRef.current?.focus();
  }

  return (
    // `method="post"` is a guard: if this form were ever submitted natively, credentials would go in the
    // request body, never in a URL.
    <form method="post" onSubmit={submit} aria-busy={pending} noValidate>
      <h1>Sign in</h1>
      {notice !== null && <p role="status">{notice}</p>}
      <div className="field">
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          name="email"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={320}
          readOnly={pending}
          aria-describedby={error === null ? undefined : errorId}
        />
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          readOnly={pending}
          aria-describedby={error === null ? undefined : errorId}
        />
      </div>
      <p id={errorId} role="alert" className="error" hidden={error === null}>
        {error}
      </p>
      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
