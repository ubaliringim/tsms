import { describe, expect, it } from 'vitest';
import {
  initialSessionState,
  sessionReducer,
  type SessionEvent,
  type SessionState,
} from '../src/client/session-state';

const USER = { id: 'u1', email: 'a@example.test', displayName: 'Synthetic' };
const run = (events: SessionEvent[], from: SessionState = initialSessionState) =>
  events.reduce(sessionReducer, from);
const signedIn = run([{ type: 'restored', outcome: { kind: 'authenticated', user: USER } }]);

describe('sessionReducer', () => {
  it('starts with no identity', () => {
    expect(initialSessionState).toEqual({ status: 'restoring' });
  });

  it('restores a valid session, a missing session, and an unreachable API distinctly', () => {
    expect(signedIn).toEqual({ status: 'authenticated', user: USER, logout: 'idle' });
    expect(run([{ type: 'restored', outcome: { kind: 'unauthenticated' } }])).toEqual({
      status: 'unauthenticated',
      notice: null,
    });
    expect(run([{ type: 'restored', outcome: { kind: 'unavailable' } }])).toEqual({
      status: 'unavailable',
    });
  });

  it('keeps a confirmed session when a later re-check cannot reach the API', () => {
    expect(
      run(
        [{ type: 'restore-started' }, { type: 'restored', outcome: { kind: 'unavailable' } }],
        signedIn,
      ),
    ).toBe(signedIn);
  });

  it('drops the identity and says so when a re-check confirms the session ended', () => {
    expect(
      run(
        [{ type: 'restore-started' }, { type: 'restored', outcome: { kind: 'unauthenticated' } }],
        signedIn,
      ),
    ).toEqual({ status: 'unauthenticated', notice: 'session-ended' });
  });

  it('holds profile data only while authenticated', () => {
    const states = [
      initialSessionState,
      run([{ type: 'restored', outcome: { kind: 'unavailable' } }]),
      run([{ type: 'restored', outcome: { kind: 'unauthenticated' } }]),
      run(
        [{ type: 'logout-started' }, { type: 'logout-finished', outcome: { kind: 'confirmed' } }],
        signedIn,
      ),
    ];
    for (const state of states) expect(JSON.stringify(state)).not.toContain(USER.email);
  });

  it('a retry from unavailable returns to the neutral state', () => {
    expect(
      run(
        [{ type: 'restore-started' }],
        run([{ type: 'restored', outcome: { kind: 'unavailable' } }]),
      ),
    ).toEqual({ status: 'restoring' });
  });

  it('signs in on a successful login', () => {
    expect(run([{ type: 'logged-in', user: USER }])).toEqual({
      status: 'authenticated',
      user: USER,
      logout: 'idle',
    });
  });

  it('signs out only when the server confirmed it', () => {
    expect(
      run(
        [{ type: 'logout-started' }, { type: 'logout-finished', outcome: { kind: 'confirmed' } }],
        signedIn,
      ),
    ).toEqual({ status: 'unauthenticated', notice: 'signed-out' });
  });

  it('stays authenticated, and says logout is unconfirmed, when the server did not confirm', () => {
    const state = run(
      [{ type: 'logout-started' }, { type: 'logout-finished', outcome: { kind: 'unconfirmed' } }],
      signedIn,
    );
    expect(state).toEqual({ status: 'authenticated', user: USER, logout: 'unconfirmed' });
  });

  it('shows logout as pending while it is in flight, and ignores logout events when not signed in', () => {
    expect(run([{ type: 'logout-started' }], signedIn)).toMatchObject({ logout: 'pending' });
    expect(run([{ type: 'logout-started' }])).toEqual(initialSessionState);
    expect(run([{ type: 'logout-finished', outcome: { kind: 'confirmed' } }])).toEqual(
      initialSessionState,
    );
  });
});
