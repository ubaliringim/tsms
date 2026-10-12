import type { LogoutOutcome, RestoreOutcome, SessionUser } from './auth-client';

/**
 * The browser's view of the session - Stage 2.8.
 *
 * Authenticated data exists in exactly one state. Every other state holds no profile, so confirmed
 * sign-out, an unknown session, and the moment before restoration finishes can never show stale identity.
 *
 *  - `restoring`        nothing is known yet; render no authenticated content
 *  - `unauthenticated`  the server said there is no valid session
 *  - `unavailable`      the server could not be asked; this is NOT a sign-out
 *  - `authenticated`    the server confirmed a session
 */
export type SessionState =
  | { readonly status: 'restoring' }
  | { readonly status: 'unauthenticated'; readonly notice: SignedOutNotice | null }
  | { readonly status: 'unavailable' }
  | { readonly status: 'authenticated'; readonly user: SessionUser; readonly logout: LogoutState };

export type SignedOutNotice = 'signed-out' | 'session-ended';
export type LogoutState = 'idle' | 'pending' | 'unconfirmed';

export type SessionEvent =
  | { readonly type: 'restore-started' }
  | { readonly type: 'restored'; readonly outcome: RestoreOutcome }
  | { readonly type: 'logged-in'; readonly user: SessionUser }
  | { readonly type: 'logout-started' }
  | { readonly type: 'logout-finished'; readonly outcome: LogoutOutcome };

export const initialSessionState: SessionState = { status: 'restoring' };

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'restore-started':
      // Retrying from `unavailable` or `unauthenticated` shows the neutral state again. A silent
      // re-validation of a confirmed session keeps it until the server answers, so a transient failure
      // cannot sign anyone out (see `restored`).
      return state.status === 'authenticated' ? state : { status: 'restoring' };

    case 'restored': {
      const { outcome } = event;
      if (outcome.kind === 'authenticated') {
        return { status: 'authenticated', user: outcome.user, logout: 'idle' };
      }
      if (outcome.kind === 'unauthenticated') {
        // Confirmed loss of an authenticated session is worth saying; a first visit is not.
        return {
          status: 'unauthenticated',
          notice: state.status === 'authenticated' ? 'session-ended' : null,
        };
      }
      // Unknown. If we were already signed in, a failed re-check proves nothing, so keep that state.
      return state.status === 'authenticated' ? state : { status: 'unavailable' };
    }

    case 'logged-in':
      return { status: 'authenticated', user: event.user, logout: 'idle' };

    case 'logout-started':
      return state.status === 'authenticated' ? { ...state, logout: 'pending' } : state;

    case 'logout-finished':
      if (state.status !== 'authenticated') return state;
      return event.outcome.kind === 'confirmed'
        ? { status: 'unauthenticated', notice: 'signed-out' }
        : { ...state, logout: 'unconfirmed' };
  }
}
