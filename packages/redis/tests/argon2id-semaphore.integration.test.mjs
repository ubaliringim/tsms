/**
 * Atomicity of the Argon2id semaphore against a real Redis - Stage 2.6 hardening.
 *
 * The API integration suite proves the bound holds through the HTTP stack. This file proves the
 * mechanism underneath it directly, because a defect in the Lua script would be far easier to diagnose
 * here than through a failing request, and because a few properties - expiry pruning, release racing a
 * renewal - are only observable at the script boundary.
 *
 * Real Redis time is used throughout. Waits are bounded and polled rather than slept to a fixed duration,
 * so a slow machine makes these tests slower rather than flaky.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeRedis, createRedisClient, pingRedis } from '../dist/client.js';
import {
  acquireArgon2idSlot,
  argon2idHolders,
  releaseArgon2idSlot,
  renewArgon2idSlot,
  RATE_LIMIT_KEY_TAG,
} from '../dist/argon2id-semaphore.js';

let client;

/**
 * This suite's own semaphore key.
 *
 * The production key is one deployment-wide key by design, so it is shared state rather than a per-suite
 * fixture: `apps/api` and `packages/redis` integration suites run concurrently against the same logical
 * Redis database, and both contending for the production key made exact holder-count assertions in both
 * suites intermittent. The key is a namespace argument to the same three scripts, so isolating it here does
 * not weaken what is proved - and the production default is exercised by the API suite, which then owns it
 * exclusively.
 */
const SEMAPHORE_KEY = `{${RATE_LIMIT_KEY_TAG}}:integration:argon2id:holders`;

/** 43 base64url characters, the only accepted holder shape. */
const holder = () => randomUUID().replace(/-/g, '').padEnd(43, 'x');

/** Poll until `check` is true or the budget expires. */
async function eventually(check, { timeoutMillis = 15_000, intervalMillis = 25 } = {}) {
  const deadline = Date.now() + timeoutMillis;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not reached within its budget');
    await new Promise((done) => setTimeout(done, intervalMillis));
  }
}

beforeAll(async () => {
  const integration = parseIntegrationEnvironment(process.env);
  client = createRedisClient(integration.TEST_REDIS_URL);
  await pingRedis(client, { timeoutMillis: 5_000 });
});

afterAll(async () => {
  if (client) await closeRedis(client);
});

beforeEach(async () => {
  await client.del(SEMAPHORE_KEY);
});

describe('semaphore capacity', () => {
  it('admits exactly the capacity and refuses the next', async () => {
    const limit = 3;
    const taken = [];
    for (let index = 0; index < limit; index += 1) {
      const id = holder();
      const decision = await acquireArgon2idSlot(client, id, {
        limit,
        leaseMillis: 30_000,
        key: SEMAPHORE_KEY,
      });
      expect(decision.acquired).toBe(true);
      taken.push(id);
    }
    const refused = await acquireArgon2idSlot(client, holder(), {
      limit,
      leaseMillis: 30_000,
      key: SEMAPHORE_KEY,
    });
    expect(refused).toEqual({ acquired: false, held: limit });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(limit);

    for (const id of taken) await releaseArgon2idSlot(client, id, { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(0);
  });

  it('admits exactly the capacity under concurrent acquisition', async () => {
    const limit = 5;
    const ids = Array.from({ length: 30 }, () => holder());
    const decisions = await Promise.all(
      ids.map((id) =>
        acquireArgon2idSlot(client, id, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY }),
      ),
    );
    expect(decisions.filter((d) => d.acquired).length).toBe(limit);
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(limit);
    for (const id of ids) await releaseArgon2idSlot(client, id, { key: SEMAPHORE_KEY });
  });

  it('reports a growing held count so saturation is diagnosable', async () => {
    const limit = 4;
    for (let expected = 1; expected <= limit; expected += 1) {
      const decision = await acquireArgon2idSlot(client, holder(), {
        limit,
        leaseMillis: 30_000,
        key: SEMAPHORE_KEY,
      });
      expect(decision).toEqual({ acquired: true, held: expected });
    }
    expect(
      await acquireArgon2idSlot(client, holder(), {
        limit,
        leaseMillis: 30_000,
        key: SEMAPHORE_KEY,
      }),
    ).toEqual({
      acquired: false,
      held: limit,
    });
  });
});

describe('lease expiry', () => {
  it('prunes an expired holder while the key itself still exists', async () => {
    // A long lease keeps the key alive throughout, so a reclaimed slot can only have come from the
    // script removing the lapsed member. With the prune removed, this case times out.
    const limit = 2;
    const leaseMillis = 30_000;
    const abandoned = holder();
    await acquireArgon2idSlot(client, abandoned, { limit, leaseMillis, key: SEMAPHORE_KEY });
    const survivor = holder();
    await acquireArgon2idSlot(client, survivor, { limit, leaseMillis, key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(2);
    expect(
      (await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY }))
        .acquired,
    ).toBe(false);

    // Force only the abandoned holder's score into the past. The key must still exist afterwards, so the
    // key TTL cannot be what reclaims the capacity.
    const clock = await client.time();
    const nowMillis = clock[0] * 1000 + Math.floor(clock[1] / 1000);
    await client.zadd(SEMAPHORE_KEY, nowMillis - 1, abandoned);
    expect(await client.exists(SEMAPHORE_KEY)).toBe(1);
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(2);

    // The crashed holder released nothing, exactly as a killed process would not.
    expect(
      (await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY }))
        .acquired,
    ).toBe(true);
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(2);

    await client.del(SEMAPHORE_KEY);
  });

  it('reclaims capacity on its own once a lease lapses with no other holder', async () => {
    const limit = 2;
    const leaseMillis = 1_000;
    await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY });
    expect(
      (await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY }))
        .acquired,
    ).toBe(true);
    expect(
      (await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY }))
        .acquired,
    ).toBe(false);

    // Both holders abandoned. Capacity must return without anyone releasing, or a crash would be a
    // permanent denial of service.
    await eventually(
      async () =>
        (await acquireArgon2idSlot(client, holder(), { limit, leaseMillis, key: SEMAPHORE_KEY }))
          .acquired,
      { timeoutMillis: 20_000 },
    );
    await client.del(SEMAPHORE_KEY);
  });

  it('expires the whole holder set rather than leaving it indefinitely', async () => {
    await acquireArgon2idSlot(client, holder(), {
      limit: 4,
      leaseMillis: 1_000,
      key: SEMAPHORE_KEY,
    });
    const ttl = await client.pttl(SEMAPHORE_KEY);
    // Bounded by twice the lease, so nothing can persist after every holder has lapsed.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_000);
    await eventually(async () => (await client.exists(SEMAPHORE_KEY)) === 0, {
      timeoutMillis: 20_000,
    });
  });

  it('keeps a renewed holder past its original lease', async () => {
    const limit = 2;
    const leaseMillis = 1_500;
    const id = holder();
    await acquireArgon2idSlot(client, id, { limit, leaseMillis, key: SEMAPHORE_KEY });

    // Renew well inside the lease, as the in-flight holder's interval does.
    await new Promise((done) => setTimeout(done, 500));
    expect(await renewArgon2idSlot(client, id, { limit, leaseMillis, key: SEMAPHORE_KEY })).toBe(
      true,
    );

    // Past the original expiry but not the renewed one, the holder is still accounted for.
    await new Promise((done) => setTimeout(done, 1_300));
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(1);
    await releaseArgon2idSlot(client, id, { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(0);
  });

  it('does not let a renewal revive a slot that already expired', async () => {
    const limit = 2;
    const leaseMillis = 1_000;
    const id = holder();
    await acquireArgon2idSlot(client, id, { limit, leaseMillis, key: SEMAPHORE_KEY });

    // Another request takes the freed capacity.
    await eventually(async () => (await argon2idHolders(client, { key: SEMAPHORE_KEY })) === 0, {
      timeoutMillis: 20_000,
    });
    const successor = holder();
    expect(
      (await acquireArgon2idSlot(client, successor, { limit, leaseMillis, key: SEMAPHORE_KEY }))
        .acquired,
    ).toBe(true);

    // The lapsed holder's late renewal must find nothing and change nothing.
    expect(await renewArgon2idSlot(client, id, { limit, leaseMillis, key: SEMAPHORE_KEY })).toBe(
      false,
    );
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(1);
    await releaseArgon2idSlot(client, successor, { key: SEMAPHORE_KEY });
  });
});

describe('release safety', () => {
  it('cannot free a slot held by a different request', async () => {
    const limit = 3;
    const mine = holder();
    const theirs = holder();
    await acquireArgon2idSlot(client, mine, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });
    await acquireArgon2idSlot(client, theirs, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });

    // A release naming an id this caller never acquired.
    await releaseArgon2idSlot(client, holder(), { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(2);

    // Releasing one frees exactly one.
    await releaseArgon2idSlot(client, theirs, { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(1);
    await releaseArgon2idSlot(client, mine, { key: SEMAPHORE_KEY });
  });

  it('is idempotent, so a duplicated release cannot free extra capacity', async () => {
    const limit = 3;
    const mine = holder();
    const other = holder();
    await acquireArgon2idSlot(client, mine, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });

    await releaseArgon2idSlot(client, mine, { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(0);

    // A second release for the same holder, now that someone else holds a slot.
    await acquireArgon2idSlot(client, other, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });
    await releaseArgon2idSlot(client, mine, { key: SEMAPHORE_KEY });
    await releaseArgon2idSlot(client, mine, { key: SEMAPHORE_KEY });
    expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(1);
    await releaseArgon2idSlot(client, other, { key: SEMAPHORE_KEY });
  });

  it('releases only the named holder when many are outstanding', async () => {
    const limit = 8;
    const ids = Array.from({ length: 8 }, () => holder());
    for (const id of ids) {
      expect(
        (await acquireArgon2idSlot(client, id, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY }))
          .acquired,
      ).toBe(true);
    }
    for (let index = 0; index < 8; index += 1) {
      await releaseArgon2idSlot(client, ids[index], { key: SEMAPHORE_KEY });
      // Exactly one holder fewer after each release: no over-release, no skipping.
      expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(7 - index);
    }
  });

  it('removes the key entirely when the last holder releases', async () => {
    const id = holder();
    await acquireArgon2idSlot(client, id, { limit: 2, leaseMillis: 30_000, key: SEMAPHORE_KEY });
    await releaseArgon2idSlot(client, id, { key: SEMAPHORE_KEY });
    // An empty sorted set would otherwise linger until its TTL, so nothing accumulates over time.
    expect(await client.exists(SEMAPHORE_KEY)).toBe(0);
  });
});

describe('shared across clients', () => {
  it('reports one global bound to every connection', async () => {
    const integration = parseIntegrationEnvironment(process.env);
    const second = createRedisClient(integration.TEST_REDIS_URL);
    const third = createRedisClient(integration.TEST_REDIS_URL);
    try {
      const limit = 3;
      for (let index = 0; index < limit; index += 1) {
        await acquireArgon2idSlot(client, holder(), {
          limit,
          leaseMillis: 30_000,
          key: SEMAPHORE_KEY,
        });
      }
      // Connections two and three represent separate API instances. A process-local counter would let
      // each of them admit its own full share; a Redis-held bound admits none.
      for (const other of [second, third]) {
        expect(
          (
            await acquireArgon2idSlot(other, holder(), {
              limit,
              leaseMillis: 30_000,
              key: SEMAPHORE_KEY,
            })
          ).acquired,
        ).toBe(false);
        expect(await argon2idHolders(other, { key: SEMAPHORE_KEY })).toBe(limit);
      }
    } finally {
      await closeRedis(second);
      await closeRedis(third);
    }
  });

  it('is released by a different connection than the one that acquired', async () => {
    // Models a request whose Redis connection rotated between acquire and release.
    const integration = parseIntegrationEnvironment(process.env);
    const other = createRedisClient(integration.TEST_REDIS_URL);
    try {
      const limit = 2;
      const id = holder();
      await acquireArgon2idSlot(client, id, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });
      expect(await argon2idHolders(other, { key: SEMAPHORE_KEY })).toBe(1);
      await releaseArgon2idSlot(other, id, { key: SEMAPHORE_KEY });
      expect(await argon2idHolders(client, { key: SEMAPHORE_KEY })).toBe(0);
    } finally {
      await closeRedis(other);
    }
  });
});

describe('no credential material in semaphore state', () => {
  it('stores only opaque holder ids', async () => {
    const limit = 2;
    const ids = Array.from({ length: 2 }, () => holder());
    for (const id of ids) {
      await acquireArgon2idSlot(client, id, { limit, leaseMillis: 30_000, key: SEMAPHORE_KEY });
    }
    const members = await client.zrange(SEMAPHORE_KEY, 0, -1);
    expect(members).toHaveLength(2);
    for (const member of members) {
      // Holder ids are 32 random bytes. Nothing a client controls can appear here.
      expect(member).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(member).not.toContain('@');
      expect(member).not.toContain('$argon2id$');
    }
    expect(SEMAPHORE_KEY).not.toContain('@');
    for (const id of ids) await releaseArgon2idSlot(client, id, { key: SEMAPHORE_KEY });
  });
});
