import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const running = [];

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
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ...env },
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

async function waitFor(record, url) {
  const deadline = Date.now() + 60000;
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
  const deadline = Date.now() + 10000;
  while (record.child.exitCode === null && !record.error && Date.now() < deadline) await delay(50);
  assert.equal(record.error, null);
  assert.equal(record.child.exitCode, 1, `${name} must fail fast on invalid configuration`);
  assert.match(record.output, /Invalid environment configuration/);
  assert.doesNotMatch(record.output, /private-invalid-value/);
  console.log(`PASS ${name} rejects invalid startup configuration without echoing its value`);
}

try {
  await rejectsInvalidEnvironment('api', { API_PORT: 'private-invalid-value' });
  await rejectsInvalidEnvironment('worker', { WORKER_HEALTH_PORT: 'private-invalid-value' });
  for (const name of ['api', 'worker']) {
    const port = await freePort();
    const env =
      name === 'api'
        ? { API_HOST: '127.0.0.1', API_PORT: String(port) }
        : { WORKER_HOST: '127.0.0.1', WORKER_HEALTH_PORT: String(port) };
    const record = launch(name, [`apps/${name}/dist/main.js`], env);
    const response = await waitFor(record, `http://127.0.0.1:${port}/health`);
    assert.deepEqual(await response.json(), { status: 'ok', service: `tsms-${name}` });
    console.log(`PASS ${name} compiled entry point and HTTP liveness`);
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
