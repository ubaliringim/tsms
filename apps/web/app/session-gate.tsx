'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createAuthClient, type AuthClient, type LoginOutcome } from '../src/client/auth-client';
import {
  initialSessionState,
  sessionReducer,
  type SignedOutNotice,
} from '../src/client/session-state';
import { LoginForm } from './login-form';

const NOTICES: Record<SignedOutNotice, string> = {
  'signed-out': 'You have been signed out.',
  'session-ended': 'Your session has ended. Sign in again to continue.',
};

/**
 * Renders the single route's content from the server-confirmed session state - Stage 2.8.
 *
 * Nothing authenticated is rendered until `GET /auth/me` has answered: the first render, the static HTML,
 * and every non-authenticated state contain no profile data, so there is nothing to flash or to leak.
 *
 * The gate is a presentation boundary, not an access control. Authorization is the API's: every protected
 * request is checked server-side against the session cookie. Hiding the shell from an unauthenticated
 * visitor is for clarity; it is not what protects any data.
 */
export function SessionGate({ client }: { client?: AuthClient }) {
  const auth = useMemo(() => client ?? createAuthClient(), [client]);
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  // Bumped on every login/logout so a slower, older /me answer cannot overwrite a newer decision.
  const generation = useRef(0);

  const restore = useCallback(
    async (signal?: AbortSignal) => {
      const started = generation.current;
      dispatch({ type: 'restore-started' });
      const outcome = await auth.restore(signal);
      if (signal?.aborted || started !== generation.current) return;
      dispatch({ type: 'restored', outcome });
    },
    [auth],
  );

  useEffect(() => {
    const controller = new AbortController();
    void restore(controller.signal);
    // A page restored from the back/forward cache can be showing an identity that has since ended.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void restore();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      controller.abort();
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [restore]);

  async function login(email: string, password: string): Promise<LoginOutcome> {
    generation.current += 1;
    const outcome = await auth.login(email, password);
    if (outcome.kind === 'success') dispatch({ type: 'logged-in', user: outcome.user });
    return outcome;
  }

  async function logout() {
    generation.current += 1;
    dispatch({ type: 'logout-started' });
    dispatch({ type: 'logout-finished', outcome: await auth.logout() });
  }

  switch (state.status) {
    case 'restoring':
      return (
        <main aria-busy="true">
          <p role="status">Checking your sessionâ€¦</p>
        </main>
      );

    case 'unavailable':
      return (
        <main>
          <h1>Service unavailable</h1>
          <p role="alert">
            We could not check your session. This does not mean you were signed out.
          </p>
          <button type="button" onClick={() => void restore()}>
            Try again
          </button>
        </main>
      );

    case 'unauthenticated':
      return (
        <main>
          <LoginForm
            onSubmit={login}
            notice={state.notice === null ? null : NOTICES[state.notice]}
          />
        </main>
      );

    case 'authenticated':
      return (
        <>
          <header className="shell-header">
            <p className="brand">TSMS Teach &amp; Admin</p>
            <div className="account">
              <span>
                Signed in as <strong>{state.user.displayName}</strong>
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                disabled={state.logout === 'pending'}
              >
                {state.logout === 'pending' ? 'Signing outâ€¦' : 'Sign out'}
              </button>
            </div>
          </header>
          <main>
            {state.logout === 'unconfirmed' && (
              <p role="alert" className="error">
                Sign-out could not be confirmed, so your session may still be active. Try again.
              </p>
            )}
            <h1>Welcome</h1>
            <p>{state.user.email}</p>
            <p>Application foundation. Product features are not available yet.</p>
          </main>
        </>
      );
  }
}
