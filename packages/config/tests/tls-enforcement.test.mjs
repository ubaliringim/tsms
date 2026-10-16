import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '../dist/env.js';

/**
 * Stage 2.9 (F-06): the production TLS rules are verified against real handshakes, not against URL strings.
 *
 * `transport-semantics.test.mjs` shows that the validator accepts only URLs the drivers' parsers turn into verified
 * settings. This file goes one step further and asks the drivers themselves. It stands up local TLS servers with
 * certificates that are untrusted, trusted but issued for a different name, and fully valid, then connects to them
 * through the installed `pg` and `ioredis` exactly as the application does (a connection URL, nothing else), and
 * observes on the SERVER side whether a TLS session was ever established.
 *
 * The weaker configurations the validator forbids are connected to as well, so the reason each is forbidden is a
 * measured fact: they complete a handshake against a certificate nobody trusts.
 *
 * Needs `openssl` to mint throwaway test certificates. It is skipped, loudly, where that is missing, and it is a
 * hard failure on CI, where its absence would silently remove the assurance.
 */

const openssl = (() => {
  for (const candidate of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    if (spawnSync(candidate, ['version']).status === 0) return candidate;
  }
  return null;
})();
if (openssl === null && process.env.CI) {
  throw new Error('openssl is required to run the TLS enforcement tests on CI');
}
const needsOpenssl = openssl === null ? it.skip : it;
if (openssl === null)
  console.warn('SKIPPED: openssl not found; TLS enforcement tests did not run.');

const here = (path) => new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const databaseManifest = decodeURIComponent(here('../../database/package.json'));
const redisManifest = decodeURIComponent(here('../../redis/package.json'));

const DOCUMENTED_FAILURES = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
];

let dir;
const pki = {};

function run(args) {
  const result = spawnSync(openssl, args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

/** A server certificate for `names`, signed by the CA in `ca` (or self-signed when `ca` is null). */
function issue(name, names, ca) {
  writeFileSync(join(dir, `${name}.cnf`), `subjectAltName=${names}\nbasicConstraints=CA:FALSE\n`);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    '/CN=tsms-test',
  ]);
  if (ca === null) {
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.pem`,
      '-days',
      '2',
      '-subj',
      '/CN=tsms-test',
      '-addext',
      `subjectAltName=${names}`,
    ]);
  } else {
    run([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${ca}.pem`,
      '-CAkey',
      `${ca}.key`,
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '2',
      '-extfile',
      `${name}.cnf`,
    ]);
  }
  return {
    key: readFileSync(join(dir, `${name}.key`)),
    cert: readFileSync(join(dir, `${name}.pem`)),
  };
}

beforeAll(() => {
  if (openssl === null) return;
  dir = mkdtempSync(join(tmpdir(), 'tsms-tls-'));
  // A certificate authority the clients are told to trust, and one they are not.
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=tsms-test-trusted-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  pki.trustedCa = join(dir, 'ca.pem');
  pki.goodForName = issue('good', 'DNS:localhost,IP:127.0.0.1', 'ca');
  pki.wrongName = issue('wrong', 'DNS:other.test', 'ca');
  pki.untrusted = issue('untrusted', 'DNS:localhost,IP:127.0.0.1', null);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Listen on loopback and report, per connection, whether a TLS session was established. */
async function server(material, { postgres = false } = {}) {
  const seen = { secure: 0, clientErrors: [], plaintextStartups: 0 };
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };

  let listener;
  if (!postgres) {
    listener = tls.createServer(material, (socket) => {
      seen.secure += 1;
      socket.destroy();
    });
    listener.on('tlsClientError', (error) => seen.clientErrors.push(error.code ?? error.message));
    listener.on('connection', track);
  } else {
    // PostgreSQL negotiates TLS in-band: the client sends an 8-byte SSLRequest, the server answers `S`, and the
    // TLS handshake follows on the same socket. Anything else is a plaintext startup.
    listener = createNetServer((socket) => {
      track(socket);
      socket.once('data', (first) => {
        const sslRequest = first.length === 8 && first.readInt32BE(4) === 80877103;
        if (!sslRequest) {
          seen.plaintextStartups += 1;
          socket.destroy();
          return;
        }
        socket.write('S');
        const secureSocket = new tls.TLSSocket(socket, { ...material, isServer: true });
        track(secureSocket);
        secureSocket.on('secure', () => {
          seen.secure += 1;
          secureSocket.destroy();
        });
        secureSocket.on('error', (error) => seen.clientErrors.push(error.code ?? error.message));
      });
    });
  }
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  return {
    seen,
    port: listener.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => listener.close(done));
    },
  };
}

/** Run a short client script in a child process, so a trust store can be chosen per case. */
function client(script, { url, trust = null, rejectUnauthorized = null }) {
  const env = {
    ...process.env,
    URL_UNDER_TEST: url,
    DB_MANIFEST: databaseManifest,
    REDIS_MANIFEST: redisManifest,
  };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (trust !== null) env.NODE_EXTRA_CA_CERTS = trust;
  if (rejectUnauthorized !== null) env.NODE_TLS_REJECT_UNAUTHORIZED = rejectUnauthorized;
  const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  return new Promise((resolve) => {
    child.on('close', () => {
      try {
        resolve(JSON.parse(output.trim().split('\n').pop()));
      } catch {
        resolve({ code: 'NO_OUTPUT' });
      }
    });
  });
}

const REDIS_CLIENT = `
const { createRequire } = require('node:module');
const { Redis } = createRequire(process.env.REDIS_MANIFEST)('ioredis');
const redis = new Redis(process.env.URL_UNDER_TEST, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 3000 });
const finish = (code) => { console.log(JSON.stringify({ code })); redis.disconnect(); process.exit(0); };
redis.on('error', (error) => finish(error.code || error.message));
redis.connect().catch(() => {});
setTimeout(() => finish('NO_TLS_ERROR_WITHIN_3S'), 3000);
`;

const PG_CLIENT = `
const { createRequire } = require('node:module');
const dbRequire = createRequire(process.env.DB_MANIFEST);
const pg = createRequire(dbRequire.resolve('pg'))('pg');
const connection = new (dbRequire('pg').Client)({ connectionString: process.env.URL_UNDER_TEST, connectionTimeoutMillis: 3000 });
const finish = (code) => { console.log(JSON.stringify({ code })); process.exit(0); };
connection.on('error', () => {});
connection.connect().then(() => finish('CONNECTED'), (error) => finish(error.code || error.message));
`;

const production = {
  NODE_ENV: 'production',
  API_HOST: '10.20.30.40',
  API_PORT: '4000',
  API_TRUSTED_ORIGINS: 'https://app.tsms.test',
  API_RATE_LIMIT_HMAC_SECRET: 'K7xQm2pR9vTb4nL6wYcZ8aD3fH5jS1gN0eU7iO2pA4yV6',
  REDIS_URL: 'rediss://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6380',
  DATABASE_URL:
    'postgresql://app:Zq8mV2xKp4Rt7NwBdG5h@db.internal.test:5432/tsms?sslmode=verify-full',
};
const validatorAccepts = (overrides) => {
  try {
    parseApiEnvironment({ ...production, ...overrides });
    return true;
  } catch {
    return false;
  }
};

const withServer = async (material, options, body) => {
  const listening = await server(material, options);
  try {
    return await body(listening);
  } finally {
    await listening.close();
  }
};

describe('Redis over rediss: the installed client verifies the certificate and the hostname', () => {
  const url = (port, host = '127.0.0.1') => `rediss://:Yw5nC9sLd3Fh6JpAeT1u@${host}:${port}`;

  needsOpenssl('refuses a certificate issued by an authority nobody trusts', async () => {
    await withServer(pki.untrusted, {}, async ({ port, seen }) => {
      const result = await client(REDIS_CLIENT, { url: url(port) });
      expect(DOCUMENTED_FAILURES).toContain(result.code);
      expect(seen.secure).toBe(0);
    });
  });

  needsOpenssl('refuses a trusted certificate issued for a different name', async () => {
    await withServer(pki.wrongName, {}, async ({ port, seen }) => {
      const result = await client(REDIS_CLIENT, { url: url(port), trust: pki.trustedCa });
      expect(result.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
      expect(seen.secure).toBe(0);
    });
  });

  needsOpenssl(
    'completes the handshake for a trusted certificate that names the host (positive control)',
    async () => {
      await withServer(pki.goodForName, {}, async ({ port, seen }) => {
        await client(REDIS_CLIENT, { url: url(port), trust: pki.trustedCa });
        expect(seen.secure).toBe(1);
      });
    },
  );

  needsOpenssl(
    'is made unverified by NODE_TLS_REJECT_UNAUTHORIZED=0, which production forbids',
    async () => {
      await withServer(pki.untrusted, {}, async ({ port, seen }) => {
        await client(REDIS_CLIENT, { url: url(port), rejectUnauthorized: '0' });
        expect(seen.secure).toBe(1);
      });
      expect(validatorAccepts({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe(false);
    },
  );

  needsOpenssl('a plain redis: URL never starts TLS, which production forbids', async () => {
    await withServer(pki.goodForName, {}, async ({ port, seen }) => {
      await client(REDIS_CLIENT, { url: `redis://:x@127.0.0.1:${port}`, trust: pki.trustedCa });
      expect(seen.secure).toBe(0);
    });
    expect(
      validatorAccepts({ REDIS_URL: 'redis://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6379' }),
    ).toBe(false);
  });
});

describe('PostgreSQL: only sslmode=verify-full is verified, and it is the only mode production accepts', () => {
  const credentials = 'app:Zq8mV2xKp4Rt7NwBdG5h';
  const url = (port, query) => `postgresql://${credentials}@127.0.0.1:${port}/tsms${query}`;
  // Each URL as production would carry it, on a host name the validator accepts, to ask the validator about it.
  const asProduction = (query) => `postgresql://${credentials}@db.internal.test:5432/tsms${query}`;

  needsOpenssl(
    'verify-full refuses a certificate issued by an authority nobody trusts',
    async () => {
      await withServer(pki.untrusted, { postgres: true }, async ({ port, seen }) => {
        const result = await client(PG_CLIENT, { url: url(port, '?sslmode=verify-full') });
        expect(DOCUMENTED_FAILURES).toContain(result.code);
        expect(seen.secure).toBe(0);
      });
    },
  );

  needsOpenssl(
    'verify-full refuses a trusted certificate issued for a different name',
    async () => {
      await withServer(pki.wrongName, { postgres: true }, async ({ port, seen }) => {
        const result = await client(PG_CLIENT, {
          url: url(port, '?sslmode=verify-full'),
          trust: pki.trustedCa,
        });
        expect(result.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
        expect(seen.secure).toBe(0);
      });
    },
  );

  needsOpenssl(
    'verify-full completes the handshake for a trusted certificate that names the host (positive control)',
    async () => {
      await withServer(pki.goodForName, { postgres: true }, async ({ port, seen }) => {
        await client(PG_CLIENT, { url: url(port, '?sslmode=verify-full'), trust: pki.trustedCa });
        expect(seen.secure).toBe(1);
      });
    },
  );

  // The weaker settings. Each is measured against a certificate nobody trusts, and each is refused by the validator.
  const weak = [
    ['no sslmode at all', '', false],
    ['sslmode=no-verify', '?sslmode=no-verify', true],
    ['sslmode=require with uselibpqcompat=true', '?sslmode=require&uselibpqcompat=true', true],
    ['sslmode=prefer with uselibpqcompat=true', '?sslmode=prefer&uselibpqcompat=true', true],
  ];
  for (const [label, query, handshakeCompletes] of weak) {
    needsOpenssl(
      `${label}: ${handshakeCompletes ? 'connects to an untrusted certificate' : 'starts no TLS'}, and production refuses it`,
      async () => {
        await withServer(pki.untrusted, { postgres: true }, async ({ port, seen }) => {
          await client(PG_CLIENT, { url: url(port, query) });
          expect(seen.secure).toBe(handshakeCompletes ? 1 : 0);
          if (!handshakeCompletes) expect(seen.plaintextStartups).toBe(1);
        });
        expect(validatorAccepts({ DATABASE_URL: asProduction(query) })).toBe(false);
      },
    );
  }

  needsOpenssl(
    'NODE_TLS_REJECT_UNAUTHORIZED=0 makes even verify-full unverified, which production forbids',
    async () => {
      await withServer(pki.untrusted, { postgres: true }, async ({ port, seen }) => {
        await client(PG_CLIENT, {
          url: url(port, '?sslmode=verify-full'),
          rejectUnauthorized: '0',
        });
        expect(seen.secure).toBe(1);
      });
      expect(validatorAccepts({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe(false);
    },
  );

  it('accepts verify-full and nothing weaker, so an accepted URL is one the driver verifies', () => {
    expect(validatorAccepts({ DATABASE_URL: asProduction('?sslmode=verify-full') })).toBe(true);
    for (const [, query] of weak)
      expect(validatorAccepts({ DATABASE_URL: asProduction(query) })).toBe(false);
  });
});
