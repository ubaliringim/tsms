/**
 * Trusted client identity for abuse protection - Stage 2.6.
 *
 * A rate limit keyed on a spoofable address is not a rate limit. This module produces exactly one
 * trusted client address, and it produces it from the transport connection only.
 *
 * `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, and every other forwarding header
 * are ignored unconditionally. They are client-supplied unless a proxy is deployed that strips and
 * rewrites them, and no such proxy exists in this architecture (Stage 2.4 established the same
 * position for the origin allowlist). Reading them here would let any caller mint unlimited fresh
 * identities by sending one header, which is precisely the bypass this stage must not have.
 *
 * ## The NAT consequence, stated plainly
 *
 * The transport peer is a network location, not a person. Every device behind one home, office,
 * campus, or mobile carrier NAT shares a single bucket. On a school network, one departing student
 * can exhaust the per-source allowance for everyone behind that gateway. Per-account and per-target
 * limits exist precisely because this control is inherently coarse, and both are always applied
 * alongside it - never the source limit alone.
 *
 * Consequently no claim is made that TSMS can identify an individual client. It can bound a network
 * source, an account, and a recovery target, which is what the accepted abuse cases need.
 *
 * ## Proxies
 *
 * `trust proxy` is deliberately **not** enabled and there is no configuration to enable it. Behind a
 * TLS-terminating load balancer every request would share one address and one bucket, which is a
 * deployment problem with a deployment answer: an explicit, reviewed proxy-trust model naming the
 * hops that are trusted. That decision is escalated rather than guessed at here.
 */

import { isIPv4, isIPv6 } from 'node:net';

/** The single address used when the transport exposes no usable peer at all. */
export const UNKNOWN_CLIENT_ADDRESS = 'unknown';

/**
 * Longest accepted input. A real address is at most 45 characters (a fully expanded IPv6 address
 * with a scope); anything longer is not an address and must not become a key input.
 */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Structural request view. `socket.remoteAddress` is the transport peer's address as reported by the
 * kernel, which no request content can influence.
 */
export interface PeerTransport {
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/**
 * Read the transport peer address, or `null` when there is none.
 *
 * A Unix-socket or already-closed connection has no address. That is not an error the caller should
 * refuse to serve on: the request still arrives over a real transport. It collapses to one shared
 * bucket, which is restrictive rather than permissive, so a broken address cannot buy extra capacity.
 */
export function transportPeerAddress(request: PeerTransport | null | undefined): string | null {
  const raw = request?.socket?.remoteAddress;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ADDRESS_LENGTH) return null;
  return raw;
}

/**
 * Fold an IPv4-mapped or IPv4-compatible IPv6 address onto the IPv4 address it embeds.
 *
 * A dual-stack socket reports an IPv4 client as `::ffff:203.0.113.7`. Treating that as a distinct
 * identity from `203.0.113.7` would hand the same client two independent buckets - one per
 * notation - which is a bypass by representation alone. Returns `null` when the address is not one
 * of those forms.
 */
function unwrapEmbeddedIpv4(address: string): string | null {
  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = address.slice(lastColon + 1);
  if (!isIPv4(tail)) return null;
  const prefix = address.slice(0, lastColon + 1).toLowerCase();
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated). Both denote the IPv4
  // address, so both collapse onto it. `::` alone stays a genuine unspecified IPv6 address.
  if (prefix === '::ffff:' || prefix === '::') return tail;
  return null;
}

/**
 * Expand an IPv6 address to its canonical eight-group lowercase form.
 *
 * `2001:DB8::1`, `2001:db8:0:0:0:0:0:1`, and the uppercase spelling are one address written three
 * ways. A limiter that hashes the literal text would treat them as three clients. Returns `null`
 * for anything that is not a well-formed IPv6 literal, including a zone/scope suffix (`fe80::1%eth0`),
 * which identifies an interface rather than a host and is not a stable client identity.
 */
function canonicalIpv6(address: string): string | null {
  if (isIPv4(address)) return null;
  if (!isIPv6(address)) return null;
  if (address.includes('%')) return null;

  // Split around '::' first: it may appear at most once and stands for one or more zero groups.
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    }
    return groups.map((group) => group.toLowerCase().padStart(4, '0'));
  };

  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    // '::' must stand for at least one zero group; '1:2:3:4:5:6:7:8::' is not valid IPv6.
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill('0000'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  // RFC 5952: longest run of two or more zero groups collapses to '::', leftmost wins.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === '0000') {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (runStart !== -1) {
      const length = index - runStart;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  // RFC 5952 canonical form: no leading zeros in a group, lowercase, longest zero run compressed to
  // '::'. Rendering the padded groups directly would emit '2001:0db8::0001', which is a different
  // string for the same address and would therefore mint a second bucket for one client.
  const render = (group: string): string => group.replace(/^0+(?=.)/, '');
  if (bestLength < 2) return groups.map(render).join(':');

  const left = groups.slice(0, bestStart).map(render).join(':');
  const right = groups
    .slice(bestStart + bestLength)
    .map(render)
    .join(':');
  return `${left}::${right}`;
}

/**
 * Reduce a transport address to one canonical text form.
 *
 * IPv4 is already canonical in `AF_INET` form. IPv6 is expanded and lowercased. IPv4-in-IPv6 forms
 * collapse onto the IPv4 address. Anything unrecognised becomes `null`, which the caller maps to one
 * shared bucket rather than to a key derived from unvalidated input.
 *
 * Exported for direct testing of each notation: a bypass that exists only in one textual spelling is
 * exactly the defect this normalisation exists to remove.
 */
export function normalizeClientAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ADDRESS_LENGTH) return null;
  // Strip brackets some stacks add around IPv6 literals; never strip whitespace silently.
  const address = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (address === '') return null;
  const embedded = unwrapEmbeddedIpv4(address.toLowerCase());
  if (embedded !== null) return embedded;
  if (isIPv4(address)) return address;
  return canonicalIpv6(address);
}

/**
 * The trusted client address for one request.
 *
 * Returns `UNKNOWN_CLIENT_ADDRESS` when the transport exposes nothing usable, so every such request
 * shares one bucket. Failing toward a shared bucket is the safe direction: an unidentified caller
 * gets a stricter limit, never a looser one.
 */
export function clientAddressOf(request: PeerTransport | null | undefined): string {
  return normalizeClientAddress(transportPeerAddress(request)) ?? UNKNOWN_CLIENT_ADDRESS;
}
