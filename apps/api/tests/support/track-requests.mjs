/**
 * Integration-test lifecycle: no request may outlive the test that launched it.
 *
 * ## The defect this closes
 *
 * When a test exceeds its timeout, vitest reports the failure and runs the teardown hooks, but the test body
 * is still executing. Requests it had already launched kept running against the application, and each of
 * them wrote its authentication event after the teardown had deleted that user's events. The teardown then
 * deleted the user, hit `ON DELETE RESTRICT`, and a user with six events was left in the database. The
 * original timeout was also hidden behind that teardown error.
 *
 * ## What this does
 *
 * Registered as a setup file, it wraps `fetch` so every request is tracked. Each suite's teardown calls
 * `settleRequests()` first, which (1) refuses any request launched from now on, so a stale test body cannot
 * keep starting work, and (2) waits for every request already in flight to finish, so the application has
 * written everything it is going to write before a row is deleted. A `beforeEach` reopens the gate for the
 * next test.
 *
 * Nothing is cancelled mid-flight: aborting a request does not stop the server-side work, so waiting for it
 * is the only way to know the writes are done. The wait is bounded; an in-flight request that never
 * settles is a hung application and is reported rather than waited on forever.
 *
 * State lives on `globalThis` so the setup file and the test files share it however vitest isolates modules.
 */

import { beforeEach } from 'vitest';

const KEY = Symbol.for('tsms.integration.requestTracker');
const SETTLE_LIMIT_MILLIS = 45_000;

function tracker() {
  globalThis[KEY] ??= { open: true, pending: new Set(), installed: false };
  return globalThis[KEY];
}

function install() {
  const state = tracker();
  if (state.installed) return;
  state.installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    if (!state.open) {
      return Promise.reject(
        new Error(
          'A request was launched after its test finished; the test body outlived its timeout.',
        ),
      );
    }
    const request = realFetch(...args);
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    state.pending.add(settled);
    void settled.then(() => state.pending.delete(settled));
    return request;
  };
}

install();

beforeEach(() => {
  tracker().open = true;
});

/** Refuse new requests and wait for those in flight. Call first in every teardown that deletes rows. */
export async function settleRequests() {
  const state = tracker();
  state.open = false;
  const deadline = Date.now() + SETTLE_LIMIT_MILLIS;
  while (state.pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`${state.pending.size} request(s) did not settle before teardown`);
    }
    await Promise.race([
      Promise.allSettled([...state.pending]),
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
}
