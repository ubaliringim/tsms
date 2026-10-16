import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  classify,
  isBelowAdvertised,
  main,
  parseAdvertisedRange,
  probeAdvertisedExpo,
  readAdvertisedExpo,
  readCliVerdict,
  runLiveCli,
  sdkFor,
} from '../scripts/expo-live-check.mjs';

/**
 * The live Expo diagnostic is informational. Its one dangerous failure is saying "compatible" when the live question
 * was not answered or was answered "no", so most cases here assert what must NOT be reported as a pass.
 */

const INSTALLED = '57.0.28';
const SDK = '57.0.0';
const probeOk = { ok: true, expoVersion: '~57.0.30' };
const cliClean = { ok: true, dependencies: [] };
const expoFinding = {
  packageName: 'expo',
  packageType: 'dependencies',
  expectedVersionOrRange: '~57.0.30',
  actualVersion: INSTALLED,
};

describe('version arithmetic', () => {
  test('understands plain, tilde and caret ranges and nothing else', () => {
    assert.deepEqual(parseAdvertisedRange('~57.0.30'), { operator: '~', floor: [57, 0, 30] });
    assert.deepEqual(parseAdvertisedRange('57.0.30'), { operator: '', floor: [57, 0, 30] });
    assert.equal(parseAdvertisedRange('>=57.0.30'), null);
    assert.equal(parseAdvertisedRange('latest'), null);
    assert.equal(parseAdvertisedRange(undefined), null);
  });

  test('a patch below the floor is below; equal or newer is not; garbage is unknown', () => {
    assert.equal(isBelowAdvertised('57.0.28', '~57.0.30'), true);
    assert.equal(isBelowAdvertised('57.0.29', '~57.0.30'), true);
    assert.equal(isBelowAdvertised('57.0.30', '~57.0.30'), false);
    assert.equal(isBelowAdvertised('57.0.31', '~57.0.30'), false);
    assert.equal(isBelowAdvertised('57.1.0', '~57.0.30'), false);
    assert.equal(isBelowAdvertised('56.9.99', '~57.0.30'), true);
    assert.equal(isBelowAdvertised('not-a-version', '~57.0.30'), null);
    assert.equal(isBelowAdvertised('57.0.30', '>=57'), null);
  });

  test('the SDK key is derived from the installed major version', () => {
    assert.equal(sdkFor('57.0.28'), '57.0.0');
    assert.equal(sdkFor('58.2.1'), '58.0.0');
    assert.equal(sdkFor('57.0.28-canary'), null);
  });
});

describe('classification', () => {
  test('INCOMPATIBLE, exit 1, when the installed expo patch is below the advertised minimum', () => {
    const result = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: { ok: true, dependencies: [expoFinding] },
    });
    assert.equal(result.status, 'INCOMPATIBLE');
    assert.equal(result.exitCode, 1);
    assert.match(
      result.lines.join('\n'),
      /BELOW Expo's currently advertised minimum \(~57\.0\.30\)/,
    );
    assert.doesNotMatch(result.lines.join('\n'), /^COMPATIBLE:/m);
  });

  test('COMPATIBLE, exit 0, only when the live check ran and agrees with the probe', () => {
    const result = classify({
      installed: '57.0.30',
      sdkVersion: SDK,
      probe: probeOk,
      cli: cliClean,
    });
    assert.equal(result.status, 'COMPATIBLE');
    assert.equal(result.exitCode, 0);
  });

  test('a CLI that reports no problem while the probe says expo is below the minimum is not a pass', () => {
    const result = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: cliClean,
    });
    assert.equal(result.status, 'INDETERMINATE');
    assert.equal(result.exitCode, 2);
    assert.match(result.lines.join('\n'), /NOT a compatibility pass/);
  });

  test('the probe alone below the minimum is still a genuine incompatibility', () => {
    const result = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: {
        ok: true,
        dependencies: [{ ...expoFinding, packageName: 'react-native', actualVersion: '0.1.0' }],
      },
    });
    assert.equal(result.status, 'INCOMPATIBLE');
    assert.equal(result.exitCode, 1);
  });

  test('a non-expo incompatibility is reported as one', () => {
    const result = classify({
      installed: '57.0.30',
      sdkVersion: SDK,
      probe: probeOk,
      cli: {
        ok: true,
        dependencies: [
          {
            packageName: 'react-native',
            packageType: 'dependencies',
            expectedVersionOrRange: '0.86.3',
            actualVersion: '0.86.2',
          },
        ],
      },
    });
    assert.equal(result.status, 'INCOMPATIBLE');
    assert.match(result.lines.join('\n'), /react-native 0\.86\.2 does not satisfy 0\.86\.3/);
  });

  test('a network failure is INDETERMINATE and distinct from an incompatibility, even if the CLI says clean', () => {
    const result = classify({
      installed: '57.0.30',
      sdkVersion: SDK,
      probe: { ok: false, kind: 'network', error: 'could not reach the endpoint (TypeError)' },
      cli: cliClean,
    });
    assert.equal(result.status, 'INDETERMINATE');
    assert.equal(result.exitCode, 2);
    assert.match(result.lines.join('\n'), /Registry or network failure/);
    assert.doesNotMatch(result.lines.join('\n'), /INCOMPATIBLE/);
  });

  test('an unusable response and a CLI that did not run are INDETERMINATE', () => {
    const unusable = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: { ok: false, kind: 'response', error: 'the response has no sdkVersions object' },
      cli: cliClean,
    });
    assert.equal(unusable.status, 'INDETERMINATE');
    assert.match(unusable.lines.join('\n'), /Unusable response/);
    const noCli = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: { ok: false, error: 'the Expo CLI did not print JSON' },
    });
    assert.equal(noCli.status, 'INDETERMINATE');
    assert.equal(noCli.exitCode, 2);
  });

  test('an installed version that cannot be compared is INDETERMINATE, never a pass', () => {
    const result = classify({ installed: 'weird', sdkVersion: SDK, probe: probeOk, cli: cliClean });
    assert.equal(result.status, 'INDETERMINATE');
  });
});

describe('the probe', () => {
  const body = (sdkVersions) => ({ data: { sdkVersions } });
  const respond = (init) => async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: init.json ?? (async () => body({ [SDK]: { expoVersion: '~57.0.30' } })),
  });

  test('reads the advertised expo range for the SDK', async () => {
    assert.deepEqual(await probeAdvertisedExpo(SDK, { fetchImpl: respond({}) }), {
      ok: true,
      expoVersion: '~57.0.30',
    });
  });

  test('a thrown fetch is a network failure', async () => {
    const result = await probeAdvertisedExpo(SDK, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'network');
  });

  test('a timeout is a network failure', async () => {
    const result = await probeAdvertisedExpo(SDK, {
      timeoutMs: 20,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'network');
  });

  test('an HTTP error is a network failure that names the status', async () => {
    const result = await probeAdvertisedExpo(SDK, {
      fetchImpl: respond({ ok: false, status: 503 }),
    });
    assert.equal(result.kind, 'network');
    assert.match(result.error, /HTTP 503/);
  });

  test('non-JSON, a missing SDK and an unparseable range are unusable responses', async () => {
    const notJson = await probeAdvertisedExpo(SDK, {
      fetchImpl: respond({
        json: async () => {
          throw new SyntaxError('x');
        },
      }),
    });
    assert.equal(notJson.kind, 'response');
    assert.equal(readAdvertisedExpo(body({}), SDK).ok, false);
    assert.equal(readAdvertisedExpo({}, SDK).ok, false);
    assert.equal(readAdvertisedExpo(body({ [SDK]: { expoVersion: '>=57' } }), SDK).ok, false);
  });
});

describe('the CLI verdict', () => {
  test('reads the unchanged --json shape', () => {
    assert.deepEqual(readCliVerdict('{"dependencies":[],"upToDate":true}'), {
      ok: true,
      dependencies: [],
    });
    const behind = JSON.stringify({ dependencies: [expoFinding], upToDate: false });
    assert.equal(readCliVerdict(behind).dependencies.length, 1);
  });

  test('anything else is unreadable, including a self-contradicting document', () => {
    assert.equal(readCliVerdict('').ok, false);
    assert.equal(readCliVerdict('Dependencies are up to date').ok, false);
    assert.equal(readCliVerdict('{"upToDate":true}').ok, false);
    assert.equal(
      readCliVerdict(JSON.stringify({ dependencies: [expoFinding], upToDate: true })).ok,
      false,
    );
    assert.equal(readCliVerdict('{"dependencies":[],"upToDate":false}').ok, false);
  });

  test('the live run removes EXPO_OFFLINE and invokes the unchanged check', () => {
    const calls = [];
    const result = runLiveCli({
      env: { EXPO_OFFLINE: '1', PATH: 'x' },
      platform: 'linux',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '{"dependencies":[],"upToDate":true}' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].command, 'pnpm');
    assert.deepEqual(calls[0].args, [
      '--filter',
      '@tsms/student-mobile',
      'exec',
      'expo',
      'install',
      '--check',
      '--json',
    ]);
    assert.equal('EXPO_OFFLINE' in calls[0].options.env, false);
    assert.equal(calls[0].options.env.PATH, 'x');
  });

  test('a spawn error or timeout is an unreadable verdict, not a pass', () => {
    const failed = runLiveCli({
      platform: 'linux',
      spawn: () => ({ error: new Error('x'), stdout: '' }),
    });
    assert.equal(failed.ok, false);
    const timedOut = runLiveCli({
      platform: 'linux',
      spawn: () => ({ signal: 'SIGTERM', stdout: '' }),
    });
    assert.equal(timedOut.ok, false);
  });
});

describe('main', () => {
  const run = async ({ installed, probe, cli, env = {} }) => {
    const out = [];
    const summary = [];
    const code = await main({
      installed,
      probe: async () => probe,
      cli: () => cli,
      env,
      log: (line) => out.push(line),
      summaryAppend: (file, text) => summary.push({ file, text }),
    });
    return { code, out: out.join('\n'), summary };
  };

  test('an incompatibility exits 1, says so, warns, and never prints a compatible result', async () => {
    const { code, out } = await run({
      installed: INSTALLED,
      probe: probeOk,
      cli: { ok: true, dependencies: [expoFinding] },
    });
    assert.equal(code, 1);
    assert.match(out, /Result: INCOMPATIBLE/);
    assert.match(out, /::warning title=Live Expo compatibility INCOMPATIBLE::/);
    assert.doesNotMatch(out, /Result: COMPATIBLE/);
  });

  test('a network failure exits 2 and labels itself indeterminate', async () => {
    const { code, out } = await run({
      installed: INSTALLED,
      probe: { ok: false, kind: 'network', error: 'could not reach the endpoint (TypeError)' },
      cli: cliClean,
    });
    assert.equal(code, 2);
    assert.match(out, /Result: INDETERMINATE/);
  });

  test('a live match exits 0 with no warning and writes the job summary when one is configured', async () => {
    const { code, out, summary } = await run({
      installed: '57.0.30',
      probe: probeOk,
      cli: cliClean,
      env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
    });
    assert.equal(code, 0);
    assert.doesNotMatch(out, /::warning/);
    assert.equal(summary.length, 1);
    assert.match(summary[0].text, /Result: COMPATIBLE/);
  });

  test('the report always states that it does not replace the offline gate', async () => {
    const { out } = await run({ installed: '57.0.30', probe: probeOk, cli: cliClean });
    assert.match(out, /does not replace the offline gate/);
  });
});

describe('workflow and script wiring', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const jobBlock = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `job ${name} exists`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    const slice = next === -1 ? rest : rest.slice(0, next + 1);
    // Comments introducing the following job sit at the end of this slice; they are not part of this job.
    return slice.replace(/(\n {2}#[^\n]*|\n)+$/, '\n');
  };

  test('the developer command is unchanged and the live command is separate', () => {
    assert.equal(
      manifest.scripts['mobile:check'],
      'pnpm --filter @tsms/student-mobile exec expo install --check',
    );
    assert.equal(manifest.scripts['mobile:check:live'], 'node scripts/expo-live-check.mjs');
    assert.match(manifest.scripts.test, /tests\/expo-live-check\.test\.mjs/);
  });

  test('the validate gate runs the compatibility check offline, exactly once, and never online', () => {
    const block = jobBlock('validate');
    assert.equal((block.match(/^\s+- run: EXPO_OFFLINE=1 pnpm mobile:check$/gm) ?? []).length, 1);
    assert.doesNotMatch(block, /^\s+- run: pnpm mobile:check\s*$/m);
    assert.doesNotMatch(block, /mobile:check:live/);
    assert.doesNotMatch(block, /continue-on-error/);
    assert.match(block, /- run: pnpm mobile:export/);
    assert.match(block, /- run: pnpm smoke/);
    assert.match(block, /- run: pnpm test:integration/);
  });

  test('the live diagnostic is its own job that runs only the live script', () => {
    const block = jobBlock('expo-live-diagnostic');
    assert.match(block, /\n {4}continue-on-error: true\n/);
    assert.match(block, /\n {8}run: pnpm mobile:check:live\n?/);
    assert.doesNotMatch(block, /EXPO_OFFLINE/);
    assert.doesNotMatch(block, /mobile:export|pnpm smoke|mobile:check\s*$/m);
  });

  test('continue-on-error exists only on the informational job, so no gate can be softened', () => {
    assert.equal((workflow.match(/^\s+continue-on-error:/gm) ?? []).length, 1);
    for (const name of ['validate', 'security-audit', 'security-audit-diff']) {
      assert.doesNotMatch(jobBlock(name), /continue-on-error:/);
    }
  });
});
