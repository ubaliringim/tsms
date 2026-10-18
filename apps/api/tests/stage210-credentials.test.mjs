import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../dist/identity/password-hasher.js';
import { validatePassword } from '../dist/identity/password-policy.js';
import { deriveAbuseKey } from '../dist/identity/auth-abuse-policy.js';
import { clientAddressOf, normalizeClientAddress } from '../dist/identity/client-identity.js';

/**
 * Stage 2.10.1 (unit level): password encoding (IDC-04) and the shape of the IPv6 source key (RL-07).
 *
 * Already covered elsewhere and deliberately not repeated: NFC versus NFD hashing (password.test.mjs, "does not
 * normalize Unicode"), counting code points with lone-surrogate rejection, and spelling-variant normalization of IPv6
 * addresses (rate-limit.test.mjs). This file adds only what those do not pin.
 *
 * INVARIANT = a property the system is meant to hold; CHARACTERIZATION = what happens today, which is not a statement
 * that it is safe or intended.
 */

const SECRET = 'stage210_credentials_suite_rate_limit_key_0123456789ab';

describe('IDC-04 password encoding', () => {
  it('CHARACTERIZATION: the length policy counts code points, not visible characters', () => {
    // Eight accented letters typed as "e" + combining acute are 16 code points and pass the 15-minimum, although a
    // person sees eight characters. Conversely seven such letters (14 code points) are refused. The policy is therefore
    // not a statement about what the user sees, and no grapheme-aware rule exists. Normalization is an owner decision.
    const eightVisible = 'é'.repeat(8);
    expect([...eightVisible]).toHaveLength(16);
    expect(validatePassword(eightVisible).valid).toBe(true);
    expect(validatePassword('é'.repeat(7)).valid).toBe(false);
  });

  it('CHARACTERIZATION: invisible characters count, so a password with no visible character is accepted', () => {
    // Fifteen zero-width spaces: valid by the policy, invisible to the person typing it. The policy has no
    // visible-character or composition rule by design (passphrases and spaces are allowed), so this is accepted.
    const invisible = '​'.repeat(15);
    expect(validatePassword(invisible).valid).toBe(true);
  });

  it('CHARACTERIZATION: compatibility forms are not folded - fullwidth letters are a different password from ASCII', async () => {
    const ascii = 'A'.repeat(15);
    const fullwidth = 'Ａ'.repeat(15); // NFKC would fold these to ASCII; no folding is applied
    expect(fullwidth.normalize('NFKC')).toBe(ascii);
    const hash = await hashPassword(ascii);
    expect((await verifyPassword(ascii, hash)).matches).toBe(true);
    expect((await verifyPassword(fullwidth, hash)).matches).toBe(false);
  });

  it('INVARIANT: a NUL character is part of the password - text after it is still compared', async () => {
    // A native binding that treated the password as a C string would stop at the NUL and accept anything after it.
    const stored = `${'a'.repeat(15)}\u0000first`;
    const impostor = `${'a'.repeat(15)}\u0000other`;
    const truncated = 'a'.repeat(15);
    expect(validatePassword(stored).valid).toBe(true);
    const hash = await hashPassword(stored);
    expect((await verifyPassword(stored, hash)).matches).toBe(true);
    expect((await verifyPassword(impostor, hash)).matches).toBe(false);
    expect((await verifyPassword(truncated, hash)).matches).toBe(false);
  });

  it('INVARIANT: a candidate is never coerced - only a string reaches hashing or verification', async () => {
    const hash = await hashPassword('x'.repeat(15));
    for (const value of [null, undefined, 123, {}, ['x'.repeat(15)], Buffer.from('x'.repeat(15))]) {
      expect(validatePassword(value).valid).toBe(false);
      expect((await verifyPassword(value, hash)).matches).toBe(false);
    }
  });
});

describe('RL-07 the source key is one exact address', () => {
  const key = (address) => deriveAbuseKey(SECRET, 'login', 'source', address);

  it('CHARACTERIZATION (N-3): two addresses in the same /64 produce different source keys, so they are different buckets', () => {
    const first = normalizeClientAddress('2001:db8:abcd:12::1');
    const second = normalizeClientAddress('2001:db8:abcd:12::2');
    expect(first).not.toBe(second);
    expect(key(first)).not.toBe(key(second));
    // Even the extremes of one /64 are separate: nothing aggregates by prefix.
    const low = normalizeClientAddress('2001:db8:abcd:12::');
    const high = normalizeClientAddress('2001:db8:abcd:12:ffff:ffff:ffff:ffff');
    expect(key(low)).not.toBe(key(high));
  });

  it('INVARIANT: every spelling of one address, including an IPv4-mapped one, yields one key', () => {
    const same = ['2001:db8:0:0:0:0:0:5', '2001:0db8::5', '2001:DB8::5', '[2001:db8::5]'];
    expect(new Set(same.map((address) => key(normalizeClientAddress(address)))).size).toBe(1);
    expect(key(normalizeClientAddress('::ffff:203.0.113.5'))).toBe(
      key(normalizeClientAddress('203.0.113.5')),
    );
  });

  it('INVARIANT: the key never contains the address, so Redis holds no client address', () => {
    const address = '2001:db8:abcd:12::1';
    const derived = key(address);
    expect(derived).not.toContain('2001');
    expect(derived).not.toContain('db8');
    expect(derived).toMatch(/^\{tsms-rl\}:login:source:[0-9a-f]{32}$/);
  });

  it('INVARIANT: only the transport peer is trusted - a request carrying forwarding headers is keyed on its socket', () => {
    const request = {
      socket: { remoteAddress: '2001:db8:abcd:12::7' },
      headers: {
        'x-forwarded-for': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
        'x-real-ip': '203.0.113.9',
      },
    };
    expect(clientAddressOf(request)).toBe('2001:db8:abcd:12::7');
  });

  it('INVARIANT: an unusable peer collapses to one shared bucket rather than an unmetered one', () => {
    for (const remoteAddress of [undefined, '', 'not-an-address', 'fe80::1%eth0']) {
      expect(clientAddressOf({ socket: { remoteAddress } })).toBe('unknown');
    }
  });
});
