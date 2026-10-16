import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareAudit, DEFAULT_BASELINE, main } from '../scripts/audit-diff.mjs';

/**
 * Stage 2.9 (F-07): the differential dependency audit.
 *
 * Every case here is a negative control for the property it names. A checker that always said "fine" would fail
 * the cases that must exit 1 or 2, and a checker that always said "deviation" would fail the case that must exit 0.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/audit-diff.mjs', import.meta.url));
const REGISTER = readFileSync(
  new URL('../docs/security/DEPENDENCY_RISK_REGISTER.md', import.meta.url),
  'utf8',
);
const baselineText = readFileSync(DEFAULT_BASELINE, 'utf8');

const advisory = (id, name, severity, versions) => ({
  github_advisory_id: id,
  module_name: name,
  severity,
  findings: versions.map((version) => ({ version, paths: ['a>b'] })),
});
const FORGE = advisory('GHSA-86w9-cpqp-85rv', 'node-forge', 'high', ['1.4.0']);
const BRACES = advisory('GHSA-vfj7-8cjw-p6xm', 'braces', 'high', ['3.0.3']);
const audit = (...advisories) =>
  JSON.stringify({
    advisories: Object.fromEntries(advisories.map((a, i) => [String(1000 + i), a])),
    metadata: {},
  });
const run = (output, code = 1) =>
  compareAudit({ auditOutput: output, auditExitCode: code, baselineText });

describe('the baseline file', () => {
  const baseline = JSON.parse(baselineText);

  test('lists exactly the two owner-accepted, unsuppressed advisories', () => {
    assert.equal(baseline.schema, 1);
    assert.deepEqual(
      baseline.advisories.map((a) => [a.id, a.package, a.severity, a.versions]),
      [
        ['GHSA-86w9-cpqp-85rv', 'node-forge', 'high', ['1.4.0']],
        ['GHSA-vfj7-8cjw-p6xm', 'braces', 'high', ['3.0.3']],
      ],
    );
  });

  test('agrees with the dependency risk register, which must name every advisory in it', () => {
    for (const { id, package: name } of baseline.advisories) {
      assert.ok(REGISTER.includes(id), `${id} is in the baseline but not in the risk register`);
      assert.ok(REGISTER.includes(name), `${name} is in the baseline but not in the risk register`);
    }
  });
});

describe('equality with the baseline', () => {
  test('the documented findings produce exit 0 and are reported as expected, never as clean', () => {
    const result = run(audit(FORGE, BRACES));
    assert.equal(result.code, 0);
    assert.match(result.report, /EXPECTED\s+GHSA-86w9-cpqp-85rv/);
    assert.match(result.report, /EXPECTED\s+GHSA-vfj7-8cjw-p6xm/);
    assert.match(result.report, /still reports these findings/);
    assert.match(result.report, /None is suppressed/);
    assert.doesNotMatch(result.report, /audit is clean|no vulnerabilit/i);
  });

  test('the order of findings does not matter', () => {
    assert.equal(run(audit(BRACES, FORGE)).code, 0);
  });
});

describe('new advisories', () => {
  const third = (severity) => advisory('GHSA-aaaa-bbbb-cccc', 'left-pad', severity, ['1.0.0']);

  for (const severity of ['moderate', 'high', 'critical']) {
    test(`a new ${severity} advisory fails the job`, () => {
      const result = run(audit(FORGE, BRACES, third(severity)));
      assert.equal(result.code, 1);
      assert.match(result.report, /UNEXPECTED\s+GHSA-aaaa-bbbb-cccc/);
    });
  }

  for (const severity of ['low', 'info']) {
    test(`a new ${severity} advisory is reported but does not fail the job`, () => {
      const result = run(audit(FORGE, BRACES, third(severity)));
      assert.equal(result.code, 0);
      assert.match(result.report, /INFO\s+GHSA-aaaa-bbbb-cccc/);
    });
  }

  test('a new advisory is detected even when a documented one has gone', () => {
    // Equal counts must not hide a swap.
    const result = run(audit(FORGE, third('high')));
    assert.equal(result.code, 1);
    assert.match(result.report, /UNEXPECTED\s+GHSA-aaaa-bbbb-cccc/);
    assert.match(result.report, /RESOLVED\s+GHSA-vfj7-8cjw-p6xm/);
  });
});

describe('changed findings', () => {
  test('a raised severity fails the job', () => {
    const result = run(audit({ ...FORGE, severity: 'critical' }, BRACES));
    assert.equal(result.code, 1);
    assert.match(result.report, /CHANGED\s+GHSA-86w9-cpqp-85rv/);
  });

  test('a lowered severity also fails, so the baseline is revisited rather than drifting', () => {
    assert.equal(run(audit({ ...FORGE, severity: 'moderate' }, BRACES)).code, 1);
  });

  test('a different vulnerable version fails the job', () => {
    assert.equal(
      run(audit(FORGE, advisory('GHSA-vfj7-8cjw-p6xm', 'braces', 'high', ['3.0.4']))).code,
      1,
    );
  });

  test('an additional vulnerable version of a documented advisory fails the job', () => {
    const wider = advisory('GHSA-vfj7-8cjw-p6xm', 'braces', 'high', ['3.0.3', '2.3.2']);
    assert.equal(run(audit(FORGE, wider)).code, 1);
  });

  test('a different package under a documented identifier fails the job', () => {
    assert.equal(run(audit(FORGE, { ...BRACES, module_name: 'brace-expansion' })).code, 1);
  });
});

describe('resolved findings', () => {
  test('a documented advisory that disappears fails the job and asks a human to update the baseline', () => {
    const result = run(audit(FORGE));
    assert.equal(result.code, 1);
    assert.match(result.report, /RESOLVED\s+GHSA-vfj7-8cjw-p6xm/);
    assert.match(result.report, /by hand; this script never rewrites the baseline/);
  });

  test('an audit with no advisories at all, and a clean status, still deviates from the baseline', () => {
    const result = run(JSON.stringify({ advisories: {} }), 0);
    assert.equal(result.code, 1);
    assert.match(result.report, /RESOLVED/);
  });
});

describe('malformed or untrustworthy audit output fails closed', () => {
  const cases = [
    ['an HTML error page', '<html>502 Bad Gateway</html>'],
    ['an empty output', ''],
    ['truncated JSON', '{"advisories": {"1": {"github_advi'],
    ['no advisories object', '{}'],
    ['advisories as an array', '{"advisories": []}'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['an error envelope', '{"error": {"code": "ERR_PNPM_AUDIT_BAD_RESPONSE"}}'],
    ['an advisory without an identifier', audit({ ...FORGE, github_advisory_id: undefined })],
    [
      'an advisory with a malformed identifier',
      audit({ ...FORGE, github_advisory_id: 'CVE-2026-0001' }),
    ],
    ['an unknown severity', audit({ ...FORGE, severity: 'catastrophic' })],
    ['a missing severity', audit({ ...FORGE, severity: undefined })],
    ['a missing package name', audit({ ...FORGE, module_name: undefined })],
    ['no findings array', audit({ ...FORGE, findings: undefined })],
    ['a finding without a version', audit({ ...FORGE, findings: [{ paths: [] }] })],
    ['the same advisory twice', audit(FORGE, FORGE, BRACES)],
  ];
  for (const [name, output] of cases) {
    test(name, () => {
      const result = run(output);
      assert.equal(result.code, 2);
      assert.match(result.report, /^ERROR: /);
    });
  }

  test('an unreadable baseline is an error, not a pass', () => {
    for (const bad of ['', '{', '{"schema": 2, "advisories": []}', '{"schema": 1}']) {
      const result = compareAudit({
        auditOutput: audit(FORGE, BRACES),
        auditExitCode: 1,
        baselineText: bad,
      });
      assert.equal(result.code, 2);
    }
  });

  test('a baseline with a duplicate or malformed entry is an error', () => {
    const entry = {
      id: 'GHSA-86w9-cpqp-85rv',
      package: 'node-forge',
      severity: 'high',
      versions: ['1.4.0'],
    };
    for (const advisories of [
      [entry, entry],
      [{ ...entry, id: 'nope' }],
      [{ ...entry, versions: [] }],
    ]) {
      const text = JSON.stringify({ schema: 1, advisories });
      assert.equal(
        compareAudit({ auditOutput: audit(FORGE), auditExitCode: 1, baselineText: text }).code,
        2,
      );
    }
  });
});

describe('command failures are separated from vulnerability exit codes', () => {
  test('exit status 1 with matching findings is the expected vulnerability status', () => {
    assert.equal(run(audit(FORGE, BRACES), 1).code, 0);
  });

  for (const code of [2, 3, 127, 130, null, undefined]) {
    test(`exit status ${code} is a command failure even with valid-looking output`, () => {
      // Called directly: the `run` helper defaults its status, which would turn `undefined` into 1.
      const result = compareAudit({
        auditOutput: audit(FORGE, BRACES),
        auditExitCode: code,
        baselineText,
      });
      assert.equal(result.code, 2);
      assert.match(result.report, /the audit command failed/);
    });
  }

  test('status 0 with advisories listed is a contradiction, not a pass', () => {
    assert.equal(run(audit(FORGE, BRACES), 0).code, 2);
  });

  test('status 1 with no advisories listed is a contradiction, not a pass', () => {
    assert.equal(run(JSON.stringify({ advisories: {} }), 1).code, 2);
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsms-audit-diff-'));
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  test('exits 0 for the baseline, 1 for a deviation, and 2 for an unreadable result', () => {
    const ok = write('ok.json', audit(FORGE, BRACES));
    const deviation = write(
      'dev.json',
      audit(FORGE, BRACES, advisory('GHSA-aaaa-bbbb-cccc', 'x', 'high', ['1.0.0'])),
    );
    const junk = write('junk.json', '<html>');
    assert.equal(cli('--audit-json', ok, '--audit-exit-code', '1').status, 0);
    assert.equal(cli('--audit-json', deviation, '--audit-exit-code', '1').status, 1);
    assert.equal(cli('--audit-json', junk, '--audit-exit-code', '1').status, 2);
    assert.equal(cli('--audit-json', ok, '--audit-exit-code', '2').status, 2);
  });

  test('refuses incomplete or invalid arguments', () => {
    assert.equal(cli().status, 2);
    assert.equal(cli('--audit-json', 'x.json').status, 2);
    assert.equal(
      cli('--audit-json', write('a.json', audit(FORGE, BRACES)), '--audit-exit-code', 'one').status,
      2,
    );
    assert.equal(
      cli('--audit-json', join(dir, 'missing.json'), '--audit-exit-code', '1').status,
      2,
    );
  });

  test('never rewrites the baseline, whatever it finds', () => {
    const digest = () => createHash('sha256').update(readFileSync(DEFAULT_BASELINE)).digest('hex');
    const before = digest();
    cli('--audit-json', write('resolved.json', audit(FORGE)), '--audit-exit-code', '1');
    cli(
      '--audit-json',
      write('new.json', audit(FORGE, BRACES, advisory('GHSA-aaaa-bbbb-cccc', 'x', 'high', ['1']))),
      '--audit-exit-code',
      '1',
    );
    assert.equal(digest(), before);
  });

  test('uses an explicit baseline when given one, and writes a step summary when asked', () => {
    const custom = write(
      'custom-baseline.json',
      JSON.stringify({
        schema: 1,
        advisories: [
          { id: 'GHSA-aaaa-bbbb-cccc', package: 'x', severity: 'high', versions: ['1.0.0'] },
        ],
      }),
    );
    const summary = join(dir, 'summary.md');
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--audit-json',
        write('c.json', audit(advisory('GHSA-aaaa-bbbb-cccc', 'x', 'high', ['1.0.0']))),
        '--audit-exit-code',
        '1',
        '--baseline',
        custom,
      ],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
    );
    assert.equal(result.status, 0);
    assert.match(readFileSync(summary, 'utf8'), /Differential dependency audit/);
  });

  test('main() reports through the supplied writer and never throws on a missing baseline', () => {
    const lines = [];
    const code = main(
      ['--baseline', join(dir, 'nope.json'), '--audit-json', 'x', '--audit-exit-code', '1'],
      {
        stdout: (line) => lines.push(line),
        summaryFile: undefined,
      },
    );
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /baseline file cannot be read/);
  });
});

describe('the real pnpm audit schema', () => {
  const sampleText = readFileSync(
    new URL('./fixtures/pnpm-audit-sample.json', import.meta.url),
    'utf8',
  );
  const sample = JSON.parse(sampleText);

  test('the fixture has the shape the parser depends on, taken from real output', () => {
    assert.equal(typeof sample.advisories, 'object');
    for (const advisory of Object.values(sample.advisories)) {
      for (const key of [
        'github_advisory_id',
        'module_name',
        'severity',
        'vulnerable_versions',
        'findings',
      ]) {
        assert.ok(key in advisory, `real advisory has ${key}`);
      }
      for (const finding of advisory.findings) {
        assert.equal(typeof finding.version, 'string');
        assert.ok(Array.isArray(finding.paths));
      }
    }
    assert.equal(typeof sample.metadata?.vulnerabilities?.high, 'number');
  });

  test('is read correctly: the real output matches the baseline, with the vulnerability exit status', () => {
    const result = run(sampleText, 1);
    assert.equal(result.code, 0);
    assert.match(result.report, /EXPECTED\s+GHSA-86w9-cpqp-85rv\s+node-forge@1\.4\.0\s+high/);
    assert.match(result.report, /EXPECTED\s+GHSA-vfj7-8cjw-p6xm\s+braces@3\.0\.3\s+high/);
  });

  test('a real-shaped advisory that is not in the baseline is caught, and so is a changed real one', () => {
    const extra = JSON.parse(sampleText);
    extra.advisories['9999999'] = {
      ...Object.values(sample.advisories)[0],
      github_advisory_id: 'GHSA-zzzz-yyyy-xxxx',
      module_name: 'other',
      severity: 'moderate',
    };
    assert.equal(run(JSON.stringify(extra), 1).code, 1);
    const changed = JSON.parse(sampleText);
    Object.values(changed.advisories)[0].findings[0].version = '9.9.9';
    assert.equal(run(JSON.stringify(changed), 1).code, 1);
  });
});

describe('the workflow keeps the original audit unsuppressed and preserves exit statuses', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobBlock = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `job ${name} exists`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    const slice = next === -1 ? rest : rest.slice(0, next + 1);
    // The comment introducing the following job sits at the end of this slice; it is not part of this job.
    return slice.replace(/(\n {2}#[^\n]*|\n)+$/, '\n');
  };
  const FORBIDDEN = [
    /continue-on-error/,
    /\|\|\s*(true|exit\s+0|:)/,
    /set \+e/,
    /--ignore/,
    /audit-level=(critical|moderate|low)/,
    /^\s*if:/m,
    /2>&1/,
    /\|\s*(tee|grep|head|tail|cat|jq)/,
  ];

  test('security-audit is exactly the original step: one command, nothing that could change its status', () => {
    const block = jobBlock('security-audit');
    assert.equal((workflow.match(/^\s+run: pnpm audit --audit-level=high$/gm) ?? []).length, 1);
    assert.match(
      block,
      / {6}- name: Dependency security audit \(expected to fail on accepted advisories\)\n {8}run: pnpm audit --audit-level=high\n?$/,
    );
    for (const pattern of FORBIDDEN) assert.doesNotMatch(block, pattern);
  });

  test('security-audit-diff runs the script with no pipe, redirect, or fallback around its exit status', () => {
    const block = jobBlock('security-audit-diff');
    assert.match(block, / {8}run: node scripts\/audit-diff\.mjs --run\n?$/);
    for (const pattern of FORBIDDEN) assert.doesNotMatch(block, pattern);
  });

  test('the script captures the audit command status itself rather than through a shell pipeline', () => {
    const source = readFileSync(new URL('../scripts/audit-diff.mjs', import.meta.url), 'utf8');
    assert.match(source, /run\.error \|\| run\.signal \? null : run\.status/);
    assert.doesNotMatch(source, /\|\|\s*true/);
  });
});
