import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const running = [];

/**
 * Stage 1 requires every server to declare its infrastructure endpoints. These
 * values point at the Docker Compose services on loopback. They are parsed and
 * validated at startup but never connected to during liveness checks, so the
 * process still starts and still reports liveness when the containers are down.
 *
 * Read from the environment so CI and local runs exercise the same real
 * credentials. If the variables are already exported - because `.env` was loaded
 * into this process - those win. The fallbacks are throwaway local values that
 * match infrastructure/docker-compose.yml.
 */
const localInfrastructure = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://tsms:tsms_local_development@127.0.0.1:5432/tsms',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://:tsms_local_redis@127.0.0.1:6379',
  // The API requires an explicit trusted-origin allowlist in every environment
  // (Stage 2.4). Same pattern as the URLs above: prefer the real exported value,
  // fall back to the documented loopback development origins.
  API_TRUSTED_ORIGINS:
    process.env.API_TRUSTED_ORIGINS ?? 'http://127.0.0.1:3000,http://127.0.0.1:3001',
};
// Asserts that these values are not echoed by any failure path.
const infrastructureSecrets = [
  ...new Set(
    [localInfrastructure.DATABASE_URL, localInfrastructure.REDIS_URL]
      .map((url) => decodeURIComponent(new URL(url).password))
      .filter(Boolean),
  ),
];
const infrastructureHosts = [
  ...new Set(
    [localInfrastructure.DATABASE_URL, localInfrastructure.REDIS_URL].map(
      (url) => new URL(url).host,
    ),
  ),
];

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

function launch(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      ...localInfrastructure,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const record = { name, child, output: '', error: null };
  child.on('error', (error) => {
    record.error = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      record.output = (record.output + data.toString()).slice(-8000);
    });
  }
  running.push(record);
  return record;
}

async function waitFor(record, url, { timeout = 60000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (record.error) throw record.error;
    if (record.child.exitCode !== null) throw new Error(`${record.name} exited: ${record.output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return response;
    } catch {
      /* Starting servers may not accept connections yet. */
    }
    await delay(150);
  }
  throw new Error(`${record.name} did not become live: ${record.output}`);
}

async function rejectsInvalidEnvironment(name, env) {
  const record = launch(`${name}-invalid-env`, [`apps/${name}/dist/main.js`], env);
  const deadline = Date.now() + 30000;
  while (record.child.exitCode === null && !record.error && Date.now() < deadline) await delay(50);
  assert.equal(record.error, null);
  assert.equal(record.child.exitCode, 1, `${name} must fail fast on invalid configuration`);
  assert.match(record.output, /Invalid environment configuration/);
  assert.doesNotMatch(record.output, /private-invalid-value/);
  console.log(`PASS ${name} rejects invalid startup configuration without echoing its value`);
}

async function rejectsMissingInfrastructureUrl(name, missingKey) {
  const record = launch(`${name}-missing-${missingKey}`, [`apps/${name}/dist/main.js`], {
    [missingKey]: '',
  });
  const deadline = Date.now() + 30000;
  while (record.child.exitCode === null && !record.error && Date.now() < deadline) await delay(50);
  assert.equal(record.error, null);
  assert.equal(record.child.exitCode, 1, `${name} must fail fast when ${missingKey} is missing`);
  assert.match(record.output, new RegExp(`Invalid environment configuration: ${missingKey}`));
  assert.doesNotMatch(record.output, new RegExp(infrastructureSecrets.join('|')));
  console.log(`PASS ${name} fails fast when ${missingKey} is missing without leaking credentials`);
}

async function rejectsMalformedInfrastructureUrl(name, key, value) {
  const record = launch(`${name}-malformed-${key}`, [`apps/${name}/dist/main.js`], {
    [key]: value,
  });
  const deadline = Date.now() + 30000;
  while (record.child.exitCode === null && !record.error && Date.now() < deadline) await delay(50);
  assert.equal(record.error, null);
  assert.equal(record.child.exitCode, 1, `${name} must fail fast on a malformed ${key}`);
  assert.match(record.output, new RegExp(`Invalid environment configuration: ${key}`));
  assert.doesNotMatch(record.output, /not-a-valid-url/);
  console.log(`PASS ${name} fails fast on a malformed ${key} without echoing it`);
}

try {
  await rejectsInvalidEnvironment('api', { API_PORT: 'private-invalid-value' });
  await rejectsInvalidEnvironment('worker', { WORKER_HEALTH_PORT: 'private-invalid-value' });
  await rejectsMissingInfrastructureUrl('api', 'DATABASE_URL');
  await rejectsMissingInfrastructureUrl('api', 'REDIS_URL');
  await rejectsMissingInfrastructureUrl('api', 'API_TRUSTED_ORIGINS');
  await rejectsMissingInfrastructureUrl('worker', 'DATABASE_URL');
  await rejectsMissingInfrastructureUrl('worker', 'REDIS_URL');
  // Stage 2.4 origin allowlist: absent, empty, or malformed must fail startup too.
  await rejectsMalformedInfrastructureUrl('api', 'API_TRUSTED_ORIGINS', 'not-a-valid-url');
  await rejectsMalformedInfrastructureUrl(
    'api',
    'API_TRUSTED_ORIGINS',
    'https://trusted.example.com/app',
  );
  await rejectsMalformedInfrastructureUrl('api', 'DATABASE_URL', 'not-a-valid-url');
  await rejectsMalformedInfrastructureUrl('api', 'REDIS_URL', 'not-a-valid-url');
  await rejectsMalformedInfrastructureUrl('worker', 'DATABASE_URL', 'not-a-valid-url');
  await rejectsMalformedInfrastructureUrl('worker', 'REDIS_URL', 'not-a-valid-url');

  const ports = {};
  for (const name of ['api', 'worker']) {
    ports[name] = await freePort();
    const env =
      name === 'api'
        ? { API_HOST: '127.0.0.1', API_PORT: String(ports[name]) }
        : { WORKER_HOST: '127.0.0.1', WORKER_HEALTH_PORT: String(ports[name]) };
    const record = launch(name, [`apps/${name}/dist/main.js`], env);
    const response = await waitFor(record, `http://127.0.0.1:${ports[name]}/health`);
    assert.deepEqual(await response.json(), { status: 'ok', service: `tsms-${name}` });
    console.log(`PASS ${name} compiled entry point and HTTP liveness`);

    // Readiness is a separate concern from liveness. The outcome depends on
    // whether Docker Compose is running, so assert the contract either way:
    // a well-formed readiness body that never leaks credentials or raw errors.
    const readiness = await fetch(`http://127.0.0.1:${ports[name]}/ready`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(readiness.headers.get('cache-control'), 'no-store');
    const body = await readiness.json();
    assert.equal(body.service, `tsms-${name}`);
    assert.equal(typeof body.ready, 'boolean');
    if (body.ready) {
      assert.equal(readiness.status, 200);
      assert.deepEqual(body.dependencies, { database: 'up', redis: 'up' });
      console.log(`PASS ${name} readiness reports both dependencies reachable`);
    } else {
      assert.equal(readiness.status, 503);
      const failed = Object.entries(body.dependencies)
        .filter(([, state]) => state !== 'up')
        .map(([name]) => name);
      assert.ok(failed.length > 0, 'a not-ready response must name the failing dependency');
      assert.ok(!infrastructureSecrets.some((secret) => JSON.stringify(body).includes(secret)));
      assert.ok(!infrastructureHosts.some((host) => JSON.stringify(body).includes(host)));
      console.log(
        `PASS ${name} readiness reports ${failed.join(', ')} unavailable without leaking details`,
      );
    }
  }

  for (const [name, heading] of [
    ['web', 'TSMS Teach &amp; Admin'],
    ['control', 'TSMS Control'],
  ]) {
    const port = await freePort();
    const require = createRequire(resolve(root, `apps/${name}/package.json`));
    const record = launch(name, [
      require.resolve('next/dist/bin/next'),
      'start',
      `apps/${name}`,
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ]);
    const response = await waitFor(record, `http://127.0.0.1:${port}/`);
    assert.ok((await response.text()).includes(heading));
    assert.equal(response.headers.get('x-powered-by'), null);
    console.log(`PASS ${name} production route`);
  }
} finally {
  await Promise.all(
    running.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
