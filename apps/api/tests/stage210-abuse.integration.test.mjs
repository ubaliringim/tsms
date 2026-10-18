import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis, createRedisClient } from '@tsms/redis';
import { PASSWORD, WRONG_PASSWORD, createHarness, tokenFrom } from './support/stage210-harness.mjs';
import { AbuseProtectionService } from '../dist/identity/abuse-protection.service.js';
import { MAX_RETRY_AFTER_SECONDS, policyFor } from '../dist/identity/auth-abuse-policy.js';
import { normalizeClientAddress } from '../dist/identity/client-identity.js';

/**
 * Stage 2.10.1: rate-limit characterization for F-04 (targeted account lockout) and the IPv6 source bucket (N-3).
 *
 * Owner decisions recorded for this stage:
 *   D2  F-04 is temporarily accepted as a DEVELOPMENT-ONLY risk. A production disposition is still required.
 *   D4  IPv6 behaviour is characterized only. Aggregation-policy changes wait for the proxy-trust design.
 *
 * The CHARACTERIZATION tests below describe a KNOWN WEAKNESS. They pass because the weakness exists today. A passing
 * test here is not evidence that the behaviour is safe, and fixing the weakness will (correctly) fail them.
 */

const h = createHarness({ secret: 'stage210_abuse_suite_rate_limit_key_0123456789abcd' });
const SERVICE_SECRET = 'stage210_abuse_service_rate_limit_key_0123456789ab';

let redis;
let service;

beforeAll(async () => {
  await h.start();
  redis = createRedisClient(h.env.TEST_REDIS_URL);
  service = new AbuseProtectionService({ secret: SERVICE_SECRET, redis });
});
afterAll(async () => {
  if (redis) await closeRedis(redis);
  await h.stop();
});
beforeEach(() => h.resetState());
afterEach(() => h.cleanup());

const target = policyFor('login', 'target');
const source = policyFor('login', 'source');

describe('RL-05 F-04 targeted account lockout (development-only accepted risk)', () => {
  const FAILURES = target.capacity; // 8

  it('policy under test: eight failures per account per fifteen minutes, ten per source per five', () => {
    // If these change, the numbers in the tests below must be reconsidered, so the policy is stated here.
    expect(target.capacity).toBe(8);
    expect(target.windowMillis).toBe(15 * 60_000);
    expect(source.capacity).toBe(10);
    expect(source.windowMillis).toBe(5 * 60_000);
  });

  it('CHARACTERIZATION (F-04): after eight wrong passwords, the account holder is refused with the CORRECT password', async () => {
    const victim = await h.account();
    for (let attempt = 0; attempt < FAILURES; attempt += 1) {
      expect((await h.login(victim.email, WRONG_PASSWORD)).status).toBe(401);
    }

    const refused = await h.login(victim.email, PASSWORD);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    expect(tokenFrom(refused)).toBeUndefined();

    // Nothing was attempted for the refused request: no session, no success event, and no extra failure event.
    expect(await h.liveSessions(victim.id)).toBe(0);
    expect(await h.events(victim.id, 'LOGIN_SUCCEEDED')).toBe(0);
    expect(await h.events(victim.id, 'LOGIN_FAILED')).toBe(FAILURES);
  });

  it('CHARACTERIZATION (F-04): the refusal says "retry in 60 seconds" although a token needs about 112 seconds to refill', async () => {
    // Retry-After is clamped to 60 s, but one token of an eight-per-fifteen-minutes bucket takes window/capacity =
    // 112.5 s. A client that obeys the header comes back too early and is refused again. The understatement is
    // documented in the Stage 2.9 record; it is pinned here so the mismatch cannot be forgotten.
    const victim = await h.account();
    for (let attempt = 0; attempt < FAILURES; attempt += 1)
      await h.login(victim.email, WRONG_PASSWORD);
    const refused = await h.login(victim.email, PASSWORD);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(MAX_RETRY_AFTER_SECONDS));
    expect(target.windowMillis / target.capacity).toBeGreaterThan(MAX_RETRY_AFTER_SECONDS * 1000);
  });

  it('CHARACTERIZATION (F-04): the lockout is scoped to the targeted account, so another account is unaffected', async () => {
    const victim = await h.account();
    const bystander = await h.account();
    for (let attempt = 0; attempt < FAILURES; attempt += 1)
      await h.login(victim.email, WRONG_PASSWORD);
    expect((await h.login(victim.email, PASSWORD)).status).toBe(429);
    expect((await h.login(bystander.email, PASSWORD)).status).toBe(200);
  });

  it('CHARACTERIZATION (F-04): the account meter is independent of the source - exhausting it from one address locks the holder out from another', async () => {
    // The HTTP tests above cannot vary the source address (every request comes from the loopback peer), so this uses
    // the real limiter against the real Redis with two explicit client addresses. This is the denial of service: anyone
    // who knows an address can keep that account's login refused by spending its failure meter from anywhere.
    const email = 'locked-out-holder@example.test';
    const attacker = { clientAddress: '198.51.100.7', normalizedEmail: email, wellFormed: true };
    const holder = { clientAddress: '203.0.113.99', normalizedEmail: email, wellFormed: true };
    for (let attempt = 0; attempt < FAILURES; attempt += 1) {
      expect((await service.decide('login', attacker)).kind).toBe('allowed');
    }
    const decision = await service.decide('login', holder);
    expect(decision.kind).toBe('limited');
    expect(decision.proceeds).toBe(false);
  });

  it('INVARIANT: a refused request is not charged again, so continued attempts do not extend the lockout', async () => {
    const email = 'not-extended@example.test';
    const context = { clientAddress: '198.51.100.8', normalizedEmail: email, wellFormed: true };
    for (let attempt = 0; attempt < FAILURES; attempt += 1) await service.decide('login', context);
    const first = await service.decide('login', context);
    for (let attempt = 0; attempt < 20; attempt += 1) await service.decide('login', context);
    const later = await service.decide('login', context);
    expect(first.kind).toBe('limited');
    expect(later.kind).toBe('limited');
    // Refusals write nothing (all-or-nothing script), so the wait does not grow with the number of refused attempts.
    expect(later.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
  });
});

describe('RL-07 IPv6 source bucket (characterization; aggregation deferred by decision D4)', () => {
  const ATTEMPTS = source.capacity; // 10

  /** Distinct accounts per attempt, so only the source dimension can be what limits the run. */
  const run = async (address, tag) => {
    const outcomes = [];
    for (let attempt = 0; attempt < ATTEMPTS + 1; attempt += 1) {
      const decision = await service.decide('login', {
        clientAddress: address,
        normalizedEmail: `${tag}-${attempt}@example.test`,
        wellFormed: true,
      });
      outcomes.push(decision.kind);
    }
    return outcomes;
  };

  it('INVARIANT: one address is limited after its allowance', async () => {
    const outcomes = await run('2001:db8:abcd:12::1', 'single');
    expect(outcomes.slice(0, ATTEMPTS)).toEqual(Array(ATTEMPTS).fill('allowed'));
    expect(outcomes[ATTEMPTS]).toBe('limited');
  });

  it('CHARACTERIZATION (N-3): every address inside one /64 has its own full source allowance', async () => {
    // A single IPv6 subscriber normally holds a whole /64, i.e. 2^64 addresses. The source key is the exact address,
    // so twelve addresses from one /64 are admitted 12 x 10 = 120 failed-login attempts in the window where one IPv4
    // address is admitted 10. The per-account meter and the global Argon2id budget still bound the damage; the
    // per-source defence against one client trying many accounts does not.
    let admitted = 0;
    for (let index = 1; index <= 12; index += 1) {
      const outcomes = await run(`2001:db8:abcd:12::${index.toString(16)}`, `pool-${index}`);
      admitted += outcomes.filter((kind) => kind === 'allowed').length;
      expect(outcomes[ATTEMPTS]).toBe('limited'); // each address is still limited on its own
    }
    expect(admitted).toBe(12 * ATTEMPTS);
  });

  it('CHARACTERIZATION: IPv4 neighbours in one /24 are likewise independent', async () => {
    const first = await run('198.51.100.20', 'v4-a');
    const second = await run('198.51.100.21', 'v4-b');
    expect(first.filter((kind) => kind === 'allowed')).toHaveLength(ATTEMPTS);
    expect(second.filter((kind) => kind === 'allowed')).toHaveLength(ATTEMPTS);
  });

  it('INVARIANT: spellings of one IPv6 address normalize to one bucket at the HTTP boundary', async () => {
    const spellings = ['2001:db8:0:0:0:0:0:5', '2001:0db8::5', '2001:DB8::5', '[2001:db8::5]'];
    const normalized = spellings.map((spelling) => normalizeClientAddress(spelling));
    expect(new Set(normalized).size).toBe(1);
    const outcomes = [];
    for (let attempt = 0; attempt < ATTEMPTS + 2; attempt += 1) {
      const decision = await service.decide('login', {
        clientAddress: normalizeClientAddress(spellings[attempt % spellings.length]),
        normalizedEmail: `spelling-${attempt}@example.test`,
        wellFormed: true,
      });
      outcomes.push(decision.kind);
    }
    expect(outcomes.filter((kind) => kind === 'allowed')).toHaveLength(ATTEMPTS);
  });
});
