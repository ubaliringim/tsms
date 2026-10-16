import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  annotationLine,
  classify,
  describeError,
  escapeAnnotationData,
  escapeAnnotationProperty,
  formatReport,
  indeterminateOutcome,
  main,
  neutralize,
  probeAdvertisedExpo,
  readAdvertisedExpo,
  readCliVerdict,
  runLiveCli,
  summaryMarkdown,
} from '../scripts/expo-live-check.mjs';

/**
 * D1 and D2 of the live Expo diagnostic.
 *
 * D1: an unexpected failure must be INDETERMINATE (exit 2), never INCOMPATIBLE (exit 1).
 * D2: nothing that did not originate in the script may reach a log, an annotation or a summary in a form that is
 *     interpreted. Several cases are negative controls: they first prove that the payload WOULD forge a command or a
 *     heading if it were printed naively, so a sanitizer that did nothing would fail the test that follows.
 */

const SDK = '57.0.0';
const INSTALLED = '57.0.28';
const probeOk = { ok: true, expoVersion: '~57.0.30' };
const cliClean = { ok: true, dependencies: [] };
const expoFinding = {
  packageName: 'expo',
  packageType: 'dependencies',
  expectedVersionOrRange: '~57.0.30',
  actualVersion: INSTALLED,
};

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const BIDI = String.fromCharCode(0x202e);
const ZERO_WIDTH = String.fromCharCode(0x200b);

/** True when the text holds a control character (other than a line feed), a line separator or a bidi override. */
const hasUnsafeCharacter = (text) =>
  [...text].some((character) => {
    const cp = character.codePointAt(0);
    return (
      (cp <= 0x1f && cp !== 0x0a) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0xfeff
    );
  });

/** What a hostile server could put in a version range that reaches the report. */
const FORGERY = `1\n::error title=forged::owned\n::stop-commands::x\r${ESC}[31mred${ESC}[0m${BIDI}${ZERO_WIDTH}%0A,::`;

const harness = async ({ installed = '57.0.30', probe, cli, env = {}, log }) => {
  const out = [];
  const summary = [];
  const code = await main({
    installed,
    probe,
    cli,
    env,
    log: log ?? ((line) => out.push(line)),
    summaryAppend: (file, text) => summary.push({ file, text }),
  });
  const text = out.join('\n');
  return { code, out: text, lines: text.split('\n'), summary };
};
const okProbe = async () => probeOk;

describe('D1: unexpected exceptions are INDETERMINATE, exit 2', () => {
  test('a throwing probe is exit 2 with a warning and a summary, and never says INCOMPATIBLE or COMPATIBLE', async () => {
    const { code, out, summary } = await harness({
      probe: async () => {
        throw new TypeError('boom');
      },
      cli: () => cliClean,
      env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
    });
    assert.equal(code, 2);
    assert.match(out, /Result: INDETERMINATE/);
    assert.match(out, /Unexpected error: TypeError: boom/);
    assert.match(out, /^::warning title=Live Expo compatibility INDETERMINATE::/m);
    assert.match(out, /NOT a compatibility pass/);
    assert.doesNotMatch(out, /Result: (INCOMPATIBLE|COMPATIBLE)/);
    assert.equal(summary.length, 1);
    assert.match(summary[0].text, /Result: INDETERMINATE/);
  });

  test('a command that cannot be found (spawn ENOENT) is exit 2 and names the cause', async () => {
    const cli = () =>
      runLiveCli({
        platform: 'linux',
        spawn: () => ({ error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) }),
      });
    const { code, out } = await harness({ probe: okProbe, cli });
    assert.equal(code, 2);
    assert.match(out, /Result: INDETERMINATE/);
    assert.match(out, /Error \[ENOENT\]: spawn pnpm ENOENT/);
  });

  test('a CLI that throws instead of returning is exit 2', async () => {
    const { code, out } = await harness({
      probe: okProbe,
      cli: () => {
        throw Object.assign(new Error("Cannot find module 'expo'"), { code: 'MODULE_NOT_FOUND' });
      },
    });
    assert.equal(code, 2);
    assert.match(out, /\[MODULE_NOT_FOUND\]/);
  });

  test('values that are not Error objects are exit 2 as well, including ones that cannot be printed', async () => {
    const unprintable = {
      toString() {
        throw new Error('cannot print');
      },
    };
    for (const thrown of ['a string', null, undefined, 42, unprintable]) {
      const { code, out } = await harness({
        probe: async () => {
          throw thrown;
        },
        cli: () => cliClean,
      });
      assert.equal(code, 2, `thrown ${typeof thrown}`);
      assert.match(out, /Result: INDETERMINATE/);
    }
  });

  test('a module that does not resolve, run as the real script, exits 2 and reports it', () => {
    // A copy of the script in a directory with no apps/student-mobile and no expo: the real resolution failure.
    const root = mkdtempSync(join(tmpdir(), 'expo-live-'));
    mkdirSync(join(root, 'scripts'));
    const copy = join(root, 'scripts', 'expo-live-check.mjs');
    copyFileSync(fileURLToPath(new URL('../scripts/expo-live-check.mjs', import.meta.url)), copy);
    const summaryFile = join(root, 'summary.md');
    const run = spawnSync(process.execPath, [copy], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stdout, /Result: INDETERMINATE/);
    assert.match(run.stdout, /\[MODULE_NOT_FOUND\]/);
    assert.match(run.stdout, /^::warning title=Live Expo compatibility INDETERMINATE::/m);
    assert.match(readFileSync(summaryFile, 'utf8'), /Result: INDETERMINATE/);
    assert.doesNotMatch(run.stdout, /Result: (INCOMPATIBLE|COMPATIBLE)/);
  });

  test('an installed version that is not a plain version is exit 2 with a warning', async () => {
    const { code, out } = await harness({
      installed: '57.0.28-canary',
      probe: okProbe,
      cli: () => cliClean,
    });
    assert.equal(code, 2);
    assert.match(out, /Result: INDETERMINATE/);
    assert.match(out, /^::warning /m);
  });

  test('a failure while reporting never changes the decided exit code', async () => {
    const failing = () => {
      throw new Error('stdout closed');
    };
    const incompatible = await harness({
      installed: INSTALLED,
      probe: okProbe,
      cli: () => ({ ok: true, dependencies: [expoFinding] }),
      log: failing,
    });
    assert.equal(incompatible.code, 1);
    const compatible = await harness({ probe: okProbe, cli: () => cliClean, log: failing });
    assert.equal(compatible.code, 0);
    const unexpected = await harness({
      probe: async () => {
        throw new Error('x');
      },
      cli: () => cliClean,
      log: failing,
    });
    assert.equal(unexpected.code, 2);
  });

  test('the exit-code contract holds: 0 compatible, 1 incompatible, 2 indeterminate', async () => {
    const compatible = await harness({ probe: okProbe, cli: () => cliClean });
    const incompatible = await harness({
      installed: INSTALLED,
      probe: okProbe,
      cli: () => ({ ok: true, dependencies: [expoFinding] }),
    });
    const indeterminate = await harness({
      probe: async () => ({ ok: false, kind: 'network', error: 'down' }),
      cli: () => cliClean,
    });
    assert.deepEqual([compatible.code, incompatible.code, indeterminate.code], [0, 1, 2]);
  });
});

describe('D2: neutralize', () => {
  test('makes line breaks, carriage returns, tabs, escapes and bidi controls visible', () => {
    assert.equal(neutralize('a\nb'), 'a\\nb');
    assert.equal(neutralize('a\rb'), 'a\\rb');
    assert.equal(neutralize('a\tb'), 'a\\tb');
    assert.equal(neutralize(`${ESC}[31m`), '\\u{1b}[31m');
    assert.equal(neutralize(CSI), '\\u{9b}');
    assert.equal(neutralize(BIDI), '\\u{202e}');
    assert.equal(neutralize(ZERO_WIDTH), '\\u{200b}');
    assert.equal(hasUnsafeCharacter(neutralize(FORGERY)), false);
    assert.equal(neutralize(FORGERY).includes('\n'), false);
  });

  test('breaks `::` apart so a log line cannot become a workflow command', () => {
    assert.equal(neutralize('::error::x'), ': :error: :x');
    assert.equal(neutralize(':::'), ': : :');
    assert.equal(neutralize('a:b'), 'a:b');
  });

  test('is idempotent, bounded, and tolerates values that are not strings', () => {
    const once = neutralize(FORGERY);
    assert.equal(neutralize(once), once);
    assert.ok(neutralize('x'.repeat(5000)).length < 500);
    assert.match(neutralize('x'.repeat(5000)), /\.\.\.\[truncated\]$/);
    assert.equal(neutralize(null), 'null');
    assert.equal(neutralize(undefined), 'undefined');
    const unprintable = {
      toString() {
        throw new Error('x');
      },
    };
    assert.equal(neutralize(unprintable), '[unprintable]');
  });

  test('leaves ordinary findings exactly as written', () => {
    for (const text of [
      "INCOMPATIBLE: the installed expo patch 57.0.28 is BELOW Expo's currently advertised minimum (~57.0.30).",
      'react-native 0.86.2 does not satisfy 0.86.3',
      '^57.0.4 >=1.2.3 <2.0.0 || 3.x @expo/cli@57.0.31',
      'C:\\Users\\dev\\apps\\student-mobile',
    ]) {
      assert.equal(neutralize(text), text);
    }
  });

  test('describeError keeps the name, the code and a bounded, safe message', () => {
    const error = Object.assign(new Error(`Cannot find module\n${ESC}[31m::error::x`), {
      code: 'MODULE_NOT_FOUND',
    });
    const line = describeError(error);
    assert.match(line, /^Error \[MODULE_NOT_FOUND\]: Cannot find module/);
    assert.equal(hasUnsafeCharacter(line) || line.includes('\n') || line.includes('::'), false);
    assert.ok(describeError('plain').startsWith('string: plain'));
  });
});

describe('D2: forged annotations and log lines', () => {
  const hostileCli = () => ({
    ok: true,
    dependencies: [
      {
        packageName: `react-native${FORGERY}`,
        packageType: 'dependencies',
        expectedVersionOrRange: FORGERY,
        actualVersion: '0.1.0',
      },
    ],
  });

  test('negative control: the payload really would forge commands if it were printed naively', () => {
    const naive = `INCOMPATIBLE: react-native does not satisfy ${FORGERY}`.split(/\r?\n|\r/);
    assert.ok(naive.some((line) => line.startsWith('::error')));
    assert.ok(naive.some((line) => line.startsWith('::stop-commands')));
    assert.equal(hasUnsafeCharacter(naive.join('\n')), true);
  });

  test('a hostile range cannot create a forged annotation or an extra command line', async () => {
    const { code, out, lines } = await harness({ probe: okProbe, cli: hostileCli });
    assert.equal(code, 1);
    assert.match(out, /Result: INCOMPATIBLE/);
    const commandLines = lines.filter((line) => line.trimStart().startsWith('::'));
    assert.equal(commandLines.length, 1);
    assert.match(commandLines[0], /^::warning title=Live Expo compatibility INCOMPATIBLE::/);
    assert.equal(out.includes('::error'), false);
    assert.equal(out.includes('::stop-commands'), false);
    assert.equal(hasUnsafeCharacter(out), false);
    assert.equal(out.includes('\r'), false);
  });

  test('a hostile range keeps enough of the text to troubleshoot with', async () => {
    const { out } = await harness({ probe: okProbe, cli: hostileCli });
    assert.match(out, /react-native/);
    assert.match(out, /0\.1\.0/);
    assert.match(out, /does not satisfy 1\\n: :error title=forged: :owned/);
  });

  test('a hostile error name from the network layer cannot inject lines', async () => {
    const error = Object.assign(new Error('x'), { name: `Fetch\n::error::net${ESC}[0m` });
    const probe = (sdk) =>
      probeAdvertisedExpo(sdk, {
        fetchImpl: async () => {
          throw error;
        },
      });
    const { code, out, lines } = await harness({ probe, cli: () => cliClean });
    assert.equal(code, 2);
    assert.equal(lines.filter((line) => line.startsWith('::')).length, 1);
    assert.equal(hasUnsafeCharacter(out), false);
    assert.match(out, /Registry or network failure/);
  });

  test('hostile CLI stdout and stderr are shown only as a short, neutralized excerpt', async () => {
    const stdout = `garbage\n::error::boom${ESC}[31m${'x'.repeat(2000)}`;
    const stderr = `warn\r\n::stop-commands::${BIDI}`;
    const cli = () =>
      runLiveCli({ platform: 'linux', spawn: () => ({ status: 1, stdout, stderr }) });
    const { code, out, lines } = await harness({ probe: okProbe, cli });
    assert.equal(code, 2);
    assert.match(out, /did not print JSON \(stdout: "garbage\\n: :error: :boom/);
    assert.match(out, /stderr: "warn\\r\\n: :stop-commands: :/);
    assert.ok(out.length < 2000, 'the excerpt is bounded');
    assert.equal(lines.filter((line) => line.startsWith('::')).length, 1);
    assert.equal(hasUnsafeCharacter(out), false);
  });

  test('a hostile server response is rejected by the strict range pattern, not echoed', () => {
    const read = readAdvertisedExpo(
      { data: { sdkVersions: { [SDK]: { expoVersion: FORGERY } } } },
      SDK,
    );
    assert.equal(read.ok, false);
    assert.equal(read.error.includes('::'), false);
    assert.equal(readCliVerdict(FORGERY).ok, false);
  });

  test('classification does not depend on the text: hostile findings stay INCOMPATIBLE, hostile errors INDETERMINATE', () => {
    const incompatible = classify({
      installed: '57.0.30',
      sdkVersion: SDK,
      probe: probeOk,
      cli: hostileCli(),
    });
    assert.equal(incompatible.status, 'INCOMPATIBLE');
    assert.equal(incompatible.exitCode, 1);
    const indeterminate = classify({
      installed: '57.0.30',
      sdkVersion: SDK,
      probe: { ok: false, kind: 'network', error: FORGERY },
      cli: cliClean,
    });
    assert.equal(indeterminate.status, 'INDETERMINATE');
    assert.equal(indeterminate.exitCode, 2);
  });
});

describe('D2: annotation structure', () => {
  test('percent, CR, LF, commas, colons and `::` in the message cannot alter the line or end the data early', () => {
    const line = annotationLine({
      status: 'INCOMPATIBLE',
      headline: `100%\r\n::error::x, key=value :: tail ${FORGERY}`,
    });
    assert.equal(line.includes('\n') || line.includes('\r'), false);
    assert.equal(
      (line.match(/::/g) ?? []).length,
      2,
      'only the command prefix and the one delimiter',
    );
    assert.match(line, /^::warning title=Live Expo compatibility INCOMPATIBLE::/);
    assert.match(line, /100%25/);
    assert.equal(hasUnsafeCharacter(line), false);
  });

  test('the data part encodes `%` so an incoming %0A cannot be decoded into a line break by the runner', () => {
    assert.equal(escapeAnnotationData('a%0Ab'), 'a%250Ab');
    assert.equal(escapeAnnotationData('50%'), '50%25');
  });

  test('a property value also encodes the property delimiters', () => {
    assert.equal(escapeAnnotationProperty('a,b:c'), 'a%2Cb%3Ac');
    const line = annotationLine({ status: 'X,title=forged::y', headline: 'h' });
    // The property section runs from after `::warning ` to the one delimiter. `,` and `:` are the only characters
    // that could end or start a property there, and neither can appear raw inside it.
    const properties = line.slice('::warning '.length, line.indexOf('::', 2));
    assert.equal(properties.includes(',') || properties.includes(':'), false);
    assert.match(properties, /^title=Live Expo compatibility X%2Ctitle=forged%3A %3Ay$/);
    assert.equal((line.match(/::/g) ?? []).length, 2);
  });

  test('a missing headline falls back to the status instead of printing "undefined"', () => {
    assert.match(annotationLine({ status: 'INDETERMINATE' }), /::INDETERMINATE$/);
  });

  test('the annotation carries the headline finding, not just the last report line', () => {
    const result = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: {
        ok: true,
        dependencies: [expoFinding, { ...expoFinding, packageName: 'react-native' }],
      },
    });
    assert.match(result.headline, /BELOW Expo's currently advertised minimum/);
    assert.match(annotationLine(result), /BELOW Expo's currently advertised minimum/);
  });
});

describe('D2: Markdown summary', () => {
  const fenceOf = (markdown) => markdown.split('\n').find((line) => /^`{3,}$/.test(line));

  test('a backtick payload cannot close the code block, so nothing after it can be formatted', () => {
    const report = formatReport({
      status: 'INCOMPATIBLE',
      lines: ['INCOMPATIBLE: x ```\n# Everything is fine\n```\n[click](http://evil.example)'],
    });
    const markdown = summaryMarkdown(report);
    const fence = fenceOf(markdown);
    assert.ok(fence.length >= 4, 'the fence is longer than the longest backtick run in the text');
    const lines = markdown.split('\n');
    const open = lines.indexOf(fence);
    const close = lines.lastIndexOf(fence);
    assert.ok(close > open);
    assert.equal(
      lines.filter((line) => line === fence).length,
      2,
      'the fence appears only to open and to close',
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith('#')),
      ['### Live Expo compatibility'],
      'the only heading is ours, outside the block',
    );
    assert.equal(
      lines.slice(open + 1, close).some((line) => line.startsWith('#')),
      false,
    );
  });

  test('negative control: unfenced, the same payload does forge a heading', () => {
    const unfenced = 'INCOMPATIBLE: x\n# Everything is fine'.split('\n');
    assert.ok(unfenced.some((line) => line.startsWith('#')));
    const safe = summaryMarkdown(formatReport({ status: 'X', lines: ['x\n# Everything is fine'] }));
    assert.equal(safe.split('\n').filter((line) => /^# /.test(line)).length, 0);
  });

  test('main writes that summary, and a throwing summary writer does not change the result', async () => {
    const { summary, code } = await harness({
      installed: INSTALLED,
      probe: okProbe,
      cli: () => ({
        ok: true,
        dependencies: [{ ...expoFinding, expectedVersionOrRange: '```\n# pwned' }],
      }),
      env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
    });
    assert.equal(code, 1);
    assert.equal(summary[0].text.split('\n').filter((line) => /^# /.test(line)).length, 0);
    const exit = await main({
      installed: INSTALLED,
      probe: okProbe,
      cli: () => ({ ok: true, dependencies: [expoFinding] }),
      env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
      log: () => {},
      summaryAppend: () => {
        throw new Error('disk full');
      },
    });
    assert.equal(exit, 1);
  });
});

describe('normal results stay readable and correct', () => {
  test('a typical incompatibility report is unchanged by neutralization', () => {
    const result = classify({
      installed: INSTALLED,
      sdkVersion: SDK,
      probe: probeOk,
      cli: {
        ok: true,
        dependencies: [
          expoFinding,
          {
            packageName: 'react-native',
            packageType: 'dependencies',
            expectedVersionOrRange: '0.86.3',
            actualVersion: '0.86.2',
          },
        ],
      },
    });
    assert.deepEqual(
      formatReport(result).split('\n').slice(2),
      result.lines.map((line) => `  ${line}`),
    );
    assert.equal(result.status, 'INCOMPATIBLE');
  });

  test('indeterminateOutcome always carries the "not a pass" statement and exit 2', () => {
    const outcome = indeterminateOutcome('why');
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.status, 'INDETERMINATE');
    assert.match(outcome.lines.join('\n'), /NOT a compatibility pass/);
  });
});
