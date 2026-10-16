#!/usr/bin/env node
/**
 * Differential dependency audit - Stage 2.9 (F-07).
 *
 * `pnpm audit --audit-level=high` fails on the two owner-accepted advisories, which is correct and stays exactly as
 * it is. The cost is that the gate is permanently red, so a THIRD advisory is indistinguishable from the two already
 * known: the workflow was red before the new finding and is red after it. This script supplies the missing signal.
 * It asks a different question: "is the set of findings exactly the documented one?"
 *
 * It does not suppress anything, does not lower a threshold, does not change what `pnpm audit` reports, and never
 * says the audit is clean while a finding exists. It never writes the baseline: a changed or resolved finding is
 * reported with an instruction for a human to review and update `docs/security/audit-baseline.json` together with
 * `docs/security/DEPENDENCY_RISK_REGISTER.md`.
 *
 * Exit codes
 *   0  the findings are exactly the baseline (informational lower-severity findings do not change this)
 *   1  a deviation: a new advisory at moderate severity or above, a changed finding, or a resolved one
 *   2  the audit result could not be read or understood, or the audit command itself failed. Fails closed.
 *
 * Usage
 *   node scripts/audit-diff.mjs --run                      run `pnpm audit --json` and compare it
 *   node scripts/audit-diff.mjs --audit-json <file> --audit-exit-code <n> [--baseline <file>]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
/** A new advisory at or above this severity fails the job. */
export const FAILING_SEVERITY = 'moderate';

const GHSA = /^GHSA(-[a-z0-9]{4}){3}$/;
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASELINE = resolve(here, '../docs/security/audit-baseline.json');

const atLeast = (severity, floor) => SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(floor);

class Unreadable extends Error {}

/** Parse the audit output into `Map<id, {id, package, severity, versions}>`, or throw `Unreadable`. */
export function parseAuditOutput(text) {
  let audit;
  try {
    audit = JSON.parse(text);
  } catch {
    throw new Unreadable(
      'the audit output is not valid JSON (the command may have failed, or the registry was unreachable)',
    );
  }
  if (typeof audit !== 'object' || audit === null || Array.isArray(audit)) {
    throw new Unreadable('the audit output is not an object');
  }
  const { advisories } = audit;
  if (typeof advisories !== 'object' || advisories === null || Array.isArray(advisories)) {
    throw new Unreadable('the audit output has no "advisories" object');
  }

  const found = new Map();
  for (const advisory of Object.values(advisories)) {
    const id = advisory?.github_advisory_id;
    if (typeof id !== 'string' || !GHSA.test(id))
      throw new Unreadable('an advisory has no valid GHSA identifier');
    if (!SEVERITIES.includes(advisory.severity))
      throw new Unreadable(`${id} has an unknown severity`);
    if (typeof advisory.module_name !== 'string' || advisory.module_name === '') {
      throw new Unreadable(`${id} has no package name`);
    }
    if (!Array.isArray(advisory.findings)) throw new Unreadable(`${id} has no findings array`);
    if (found.has(id)) throw new Unreadable(`${id} appears more than once`);
    const versions = advisory.findings.map((finding) => {
      if (typeof finding?.version !== 'string')
        throw new Unreadable(`${id} has a finding with no version`);
      return finding.version;
    });
    found.set(id, {
      id,
      package: advisory.module_name,
      severity: advisory.severity,
      versions: [...new Set(versions)].sort(),
    });
  }
  return found;
}

/** Validate the baseline file's structure, or throw `Unreadable`. */
export function parseBaseline(text) {
  let baseline;
  try {
    baseline = JSON.parse(text);
  } catch {
    throw new Unreadable('the baseline is not valid JSON');
  }
  if (baseline?.schema !== 1 || !Array.isArray(baseline.advisories)) {
    throw new Unreadable('the baseline has an unsupported structure');
  }
  const expected = new Map();
  for (const entry of baseline.advisories) {
    if (typeof entry?.id !== 'string' || !GHSA.test(entry.id))
      throw new Unreadable('a baseline entry has no valid GHSA identifier');
    if (expected.has(entry.id)) throw new Unreadable(`the baseline lists ${entry.id} twice`);
    if (!SEVERITIES.includes(entry.severity))
      throw new Unreadable(`the baseline severity for ${entry.id} is unknown`);
    if (
      typeof entry.package !== 'string' ||
      !Array.isArray(entry.versions) ||
      entry.versions.length === 0
    ) {
      throw new Unreadable(`the baseline entry for ${entry.id} is incomplete`);
    }
    expected.set(entry.id, { ...entry, versions: [...entry.versions].sort() });
  }
  return expected;
}

/**
 * Compare an audit run with the baseline.
 *
 * `auditExitCode` is the exit status of the audit command. 0 and 1 are the only statuses `pnpm audit` uses to
 * report its verdict (clean, or findings); any other value, or none, means the command itself failed. The status
 * must also agree with the output: findings with status 0, or status 1 with no findings, is a contradiction, and a
 * contradiction is an error, never a pass.
 */
export function compareAudit({ auditOutput, auditExitCode, baselineText }) {
  const lines = [];
  const result = (code) => ({ code, lines, report: lines.join('\n') });
  const fail = (message) => {
    lines.push(`ERROR: ${message}.`);
    return result(2);
  };

  let expected;
  try {
    expected = parseBaseline(baselineText);
  } catch (error) {
    if (error instanceof Unreadable) return fail(error.message);
    throw error;
  }

  if (auditExitCode !== 0 && auditExitCode !== 1) {
    return fail(
      `the audit command failed (exit status ${auditExitCode ?? 'none'}); its output was not trusted`,
    );
  }
  let found;
  try {
    found = parseAuditOutput(auditOutput);
  } catch (error) {
    if (error instanceof Unreadable) return fail(error.message);
    throw error;
  }
  if (auditExitCode === 0 && found.size > 0)
    return fail('the audit reported success but listed advisories');
  if (auditExitCode === 1 && found.size === 0)
    return fail('the audit failed but listed no advisories');

  const unexpected = [];
  const changed = [];
  const informational = [];
  const matching = [];
  for (const finding of found.values()) {
    const baseline = expected.get(finding.id);
    if (baseline === undefined) {
      (atLeast(finding.severity, FAILING_SEVERITY) ? unexpected : informational).push(finding);
      continue;
    }
    const same =
      baseline.package === finding.package &&
      baseline.severity === finding.severity &&
      JSON.stringify(baseline.versions) === JSON.stringify(finding.versions);
    (same ? matching : changed).push(same ? finding : { baseline, now: finding });
  }
  const resolved = [...expected.values()].filter((entry) => !found.has(entry.id));

  const describe = (f) => `${f.id}  ${f.package}@${f.versions.join(',')}  ${f.severity}`;
  lines.push(
    `Audit findings: ${found.size}. Documented baseline: ${expected.size}.`,
    'The dependency audit still reports these findings. None is suppressed, and this check does not make the audit clean.',
  );
  for (const f of matching) lines.push(`  EXPECTED    ${describe(f)}`);
  for (const f of informational) {
    lines.push(`  INFO        ${describe(f)}  (below ${FAILING_SEVERITY}; not in the baseline)`);
  }
  for (const f of unexpected) lines.push(`  UNEXPECTED  ${describe(f)}  <- not in the baseline`);
  for (const c of changed) {
    lines.push(
      `  CHANGED     ${c.now.id}  baseline ${c.baseline.package}@${c.baseline.versions.join(',')} ${c.baseline.severity}` +
        `  now ${c.now.package}@${c.now.versions.join(',')} ${c.now.severity}`,
    );
  }
  for (const e of resolved) {
    lines.push(
      `  RESOLVED    ${e.id}  ${e.package}  <- no longer reported. Review it, then update docs/security/audit-baseline.json` +
        ' and docs/security/DEPENDENCY_RISK_REGISTER.md by hand; this script never rewrites the baseline',
    );
  }

  const deviations = unexpected.length + changed.length + resolved.length;
  lines.push(
    deviations === 0
      ? 'Result: the findings are exactly the documented baseline.'
      : `Result: ${deviations} deviation(s) from the documented baseline.`,
  );
  return result(deviations === 0 ? 0 : 1);
}

function summaryTable(result) {
  return ['### Differential dependency audit', '', '```', result.report, '```', ''].join('\n');
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** CLI entry. Separate from `compareAudit` so the decision logic is testable without a process or a network. */
export function main(
  args,
  { stdout = console.log, summaryFile = process.env.GITHUB_STEP_SUMMARY } = {},
) {
  const baselinePath = resolve(optionValue(args, '--baseline') ?? DEFAULT_BASELINE);
  let baselineText;
  try {
    baselineText = readFileSync(baselinePath, 'utf8');
  } catch {
    stdout('ERROR: the baseline file cannot be read.');
    return 2;
  }

  let auditOutput;
  let auditExitCode;
  if (args.includes('--run')) {
    const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 };
    // On Windows `pnpm` is a `.cmd` shim, which needs a shell. A fixed command string (no interpolated
    // arguments) avoids the argument-concatenation hazard that passing an array with a shell would introduce.
    const run =
      process.platform === 'win32'
        ? spawnSync('pnpm audit --json', { ...options, shell: true })
        : spawnSync('pnpm', ['audit', '--json'], options);
    auditOutput = run.stdout ?? '';
    auditExitCode = run.error || run.signal ? null : run.status;
  } else {
    const file = optionValue(args, '--audit-json');
    const code = optionValue(args, '--audit-exit-code');
    if (file === undefined || code === undefined || !/^\d+$/.test(code)) {
      stdout(
        'ERROR: usage: audit-diff.mjs --run | --audit-json <file> --audit-exit-code <n> [--baseline <file>].',
      );
      return 2;
    }
    try {
      auditOutput = readFileSync(resolve(file), 'utf8');
    } catch {
      stdout('ERROR: the audit output file cannot be read.');
      return 2;
    }
    auditExitCode = Number(code);
  }

  const result = compareAudit({ auditOutput, auditExitCode, baselineText });
  stdout(result.report);
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, summaryTable(result));
    } catch {
      // A summary is a convenience; failing to write it must not change the verdict.
    }
  }
  return result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
