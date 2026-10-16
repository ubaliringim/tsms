#!/usr/bin/env node
/**
 * Live Expo compatibility diagnostic - INFORMATIONAL.
 *
 * The CI gate is `EXPO_OFFLINE=1 pnpm mobile:check`, which validates against the `bundledNativeModules.json` shipped
 * inside the installed `expo` package. That is reproducible, but it cannot see the minimum `expo` patch that Expo's
 * servers currently advertise for the SDK. This script asks the live question and is NOT a replacement for the gate.
 *
 * It does two independent things and compares them:
 *   1. Asks Expo's versions endpoint (the one `expo install --check` itself uses) which `expo` range it advertises.
 *   2. Runs the unchanged online `expo install --check --json` and reads its verdict.
 * The probe exists because the Expo CLI caches responses for five minutes and falls back to local metadata on some
 * failures, so a "dependencies are up to date" from the CLI alone is not proof that a live check happened.
 *
 * Statuses (the word PASS is never used for anything but a verified live match)
 *   COMPATIBLE     exit 0  the live check ran, agrees with the probe, and nothing is below Expo's advertised range
 *   INCOMPATIBLE   exit 1  the live check ran and something, usually the `expo` patch, is below what Expo advertises
 *   INDETERMINATE  exit 2  the live question could not be answered: network or HTTP failure, an unreadable or
 *                          unexpected response, the CLI failing to run, the two sources contradicting each other, or
 *                          ANY unexpected exception (an unexpected failure is never a confirmed incompatibility)
 *
 * Everything printed that did not originate in this file is untrusted and is neutralized for its output context (see
 * `neutralize`). Nothing here writes to the repository, changes a version, or suppresses a result.
 *
 * Usage
 *   node scripts/expo-live-check.mjs
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSIONS_URL = 'https://api.expo.dev/v2/versions/latest';
export const PROBE_TIMEOUT_MS = 15_000;
export const CLI_TIMEOUT_MS = 120_000;
export const MOBILE_PACKAGE = '@tsms/student-mobile';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ADVERTISED = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/;

const parse = (text) => {
  const match = SEMVER.exec(text);
  return match ? match.slice(1).map(Number) : null;
};

/** Negative when a < b. Both are `[major, minor, patch]`. */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Output safety. Everything the diagnostic prints that did not come from this file is untrusted: Expo's server, the Expo
 * CLI's stdout and stderr, dependency names and ranges (which the CLI derives from the server), and exception messages.
 * There are three output contexts and each needs its own handling:
 *
 *   plain log    GitHub scans log lines for `::command::` and a terminal interprets escape sequences, so control
 *                characters and line breaks are made visible (`\n`, `\u{1b}`) and `::` is broken apart.
 *   annotation   the message of a `::warning` line must also encode `%`, CR and LF the way the runner decodes them.
 *   summary      Markdown: the report is placed in a fenced code block whose fence is longer than any backtick run in
 *                the text, and the text has no line breaks, so it can neither close the block nor start a heading.
 *
 * `neutralize` is idempotent, so it is applied again at the output boundary as defence in depth. Backslashes are not
 * escaped (that would break idempotence), so a literal `\n` in the input is indistinguishable from an escaped newline.
 */
export const MAX_FIELD_LENGTH = 400;
const VISIBLE_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

const isUnsafeCodePoint = (cp) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x2028 ||
  cp === 0x2029 ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff;

const toText = (value) => {
  try {
    return typeof value === 'string' ? value : String(value);
  } catch {
    return '[unprintable]';
  }
};

/** Make untrusted text safe for a single log line: no control characters, no line breaks, no `::`, bounded length. */
export function neutralize(value, maxLength = MAX_FIELD_LENGTH) {
  let out = '';
  let count = 0;
  for (const character of toText(value)) {
    if (count >= maxLength) {
      out += '...[truncated]';
      break;
    }
    count += 1;
    const cp = character.codePointAt(0);
    out +=
      VISIBLE_ESCAPES[character] ?? (isUnsafeCodePoint(cp) ? `\\u{${cp.toString(16)}}` : character);
  }
  return out.replace(/:{2,}/g, (run) => run.split('').join(' '));
}

/** The data part of a `::warning` command: `%`, CR and LF are encoded the way the Actions runner decodes them. */
export const escapeAnnotationData = (value) =>
  neutralize(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A property value (the title): as the data part, and also `:` and `,`, which delimit properties. */
export const escapeAnnotationProperty = (value) =>
  escapeAnnotationData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** A Markdown block that the text inside it cannot close. */
export function summaryMarkdown(reportText) {
  const text = reportText
    .split('\n')
    .map((line) => neutralize(line))
    .join('\n');
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `### Live Expo compatibility\n\n${fence}\n${text}\n${fence}\n`;
}

/** One line describing an unexpected failure, safe to print. */
export function describeError(error) {
  const name = error instanceof Error ? error.name : typeof error;
  const code = error?.code ? ` [${neutralize(error.code, 40)}]` : '';
  const message = error instanceof Error ? error.message : error;
  return `${neutralize(name, 60)}${code}: ${neutralize(message, 300)}`;
}

/**
 * Parse the range Expo advertises for `expo` (for example `~57.0.30`). Only a plain version with an optional `~` or
 * `^` is understood; anything else returns null and the caller treats the live answer as indeterminate rather than
 * guessing.
 */
export function parseAdvertisedRange(text) {
  const match = typeof text === 'string' ? ADVERTISED.exec(text) : null;
  if (!match) return null;
  return { operator: match[1], floor: [Number(match[2]), Number(match[3]), Number(match[4])] };
}

/** True when `installed` is below the advertised range's minimum. */
export function isBelowAdvertised(installedText, advertisedText) {
  const installed = parse(installedText);
  const advertised = parseAdvertisedRange(advertisedText);
  if (!installed || !advertised) return null;
  return compare(installed, advertised.floor) < 0;
}

/** Pull `expoVersion` for the SDK out of the endpoint's response body, or describe why it is not there. */
export function readAdvertisedExpo(body, sdkVersion) {
  const sdkVersions = body?.data?.sdkVersions;
  if (typeof sdkVersions !== 'object' || sdkVersions === null) {
    return { ok: false, error: 'the response has no sdkVersions object' };
  }
  const entry = sdkVersions[sdkVersion];
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, error: `the response has no entry for SDK ${sdkVersion}` };
  }
  if (!parseAdvertisedRange(entry.expoVersion)) {
    return { ok: false, error: 'the advertised expo version is missing or not a plain range' };
  }
  return { ok: true, expoVersion: entry.expoVersion };
}

/** Ask Expo's server which `expo` range it advertises. Never throws. */
export async function probeAdvertisedExpo(
  sdkVersion,
  { fetchImpl = globalThis.fetch, url = VERSIONS_URL, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return {
      ok: false,
      kind: 'network',
      error: `could not reach ${url} (${error?.name ?? 'error'})`,
    };
  }
  if (!response.ok) {
    return { ok: false, kind: 'network', error: `${url} answered HTTP ${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: 'response', error: `${url} did not return JSON` };
  }
  const read = readAdvertisedExpo(body, sdkVersion);
  return read.ok ? read : { ok: false, kind: 'response', error: read.error };
}

const excerpt = (label, text) => {
  const trimmed = toText(text ?? '').trim();
  return trimmed ? `${label}: "${neutralize(trimmed, 200)}"` : '';
};

/** Interpret the stdout of `expo install --check --json`. Short sanitized excerpts of the output aid troubleshooting. */
export function readCliVerdict(stdout, stderr = '') {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const detail = [excerpt('stdout', stdout), excerpt('stderr', stderr)]
      .filter(Boolean)
      .join(', ');
    return { ok: false, error: `the Expo CLI did not print JSON${detail ? ` (${detail})` : ''}` };
  }
  if (typeof parsed?.upToDate !== 'boolean' || !Array.isArray(parsed.dependencies)) {
    return { ok: false, error: 'the Expo CLI JSON has an unexpected shape' };
  }
  if (parsed.upToDate !== (parsed.dependencies.length === 0)) {
    return { ok: false, error: 'the Expo CLI JSON contradicts itself' };
  }
  return { ok: true, dependencies: parsed.dependencies };
}

/** The one shape every "could not be determined" result takes, so none can be mistaken for a pass. */
export const indeterminateOutcome = (reason, lines = []) => ({
  status: 'INDETERMINATE',
  exitCode: 2,
  headline: reason,
  lines: [
    ...lines,
    reason,
    'The live Expo requirement could not be determined. This is NOT a compatibility pass.',
  ],
});

/**
 * Combine the probe, the CLI verdict and the installed version into one status. Pure, so every branch is testable.
 * `probe` and `cli` are the results of `probeAdvertisedExpo` and `readCliVerdict` (or a failed CLI run).
 */
export function classify({ installed, sdkVersion, probe, cli }) {
  const lines = [];
  const indeterminate = (reason) => indeterminateOutcome(reason, lines);

  lines.push(`Installed expo: ${installed} (SDK ${sdkVersion})`);
  if (!probe.ok) {
    const label = probe.kind === 'network' ? 'Registry or network failure' : 'Unusable response';
    return indeterminate(`${label}: ${probe.error}.`);
  }
  lines.push(`Expo advertises for this SDK: expo ${probe.expoVersion}`);
  if (!cli.ok) return indeterminate(`The live Expo check did not produce a verdict: ${cli.error}.`);

  const probeBelow = isBelowAdvertised(installed, probe.expoVersion);
  if (probeBelow === null)
    return indeterminate('The installed or advertised expo version could not be compared.');

  const expoFinding = cli.dependencies.find((dependency) => dependency.packageName === 'expo');
  const cliBelow = Boolean(expoFinding);
  const others = cli.dependencies.filter((dependency) => dependency.packageName !== 'expo');

  // The CLI says everything is fine while the probe says expo is below the advertised minimum: the CLI answered from
  // a cache or from local metadata. Do not call that a live pass.
  if (cli.dependencies.length === 0 && probeBelow) {
    return indeterminate(
      'The Expo CLI reported no problem but the live endpoint advertises a higher expo patch.',
    );
  }

  if (cliBelow || probeBelow || others.length > 0) {
    if (cliBelow || probeBelow) {
      const expected = expoFinding?.expectedVersionOrRange ?? probe.expoVersion;
      lines.push(
        `INCOMPATIBLE: the installed expo patch ${installed} is BELOW Expo's currently advertised minimum (${expected}).`,
      );
    }
    for (const dependency of others) {
      lines.push(
        `INCOMPATIBLE: ${dependency.packageName} ${dependency.actualVersion} does not satisfy ${dependency.expectedVersionOrRange}.`,
      );
    }
    const headline = lines.find((line) => line.startsWith('INCOMPATIBLE:'));
    return { status: 'INCOMPATIBLE', exitCode: 1, headline, lines };
  }

  const compatible = 'COMPATIBLE: the live check ran and nothing is below what Expo advertises.';
  lines.push(compatible);
  return { status: 'COMPATIBLE', exitCode: 0, headline: compatible, lines };
}

/** Run the unchanged online check. `EXPO_OFFLINE` is removed so this can never fall into the offline path. */
export function runLiveCli({
  spawn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) {
  const liveEnv = { ...env };
  delete liveEnv.EXPO_OFFLINE;
  const result = spawn(
    platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', MOBILE_PACKAGE, 'exec', 'expo', 'install', '--check', '--json'],
    { encoding: 'utf8', env: liveEnv, timeout: CLI_TIMEOUT_MS, shell: platform === 'win32' },
  );
  if (result.error || result.signal) {
    const cause = result.error
      ? ` (${describeError(result.error)})`
      : ` (terminated by signal ${neutralize(result.signal, 20)})`;
    return { ok: false, error: `the Expo CLI did not run to completion${cause}` };
  }
  return readCliVerdict(result.stdout ?? '', result.stderr ?? '');
}

/** The installed expo version, read the way the app resolves it. */
export function readInstalledExpo(root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const require = createRequire(resolve(root, 'apps/student-mobile/package.json'));
  return require('expo/package.json').version;
}

export const sdkFor = (installed) => {
  const parts = parse(installed);
  return parts ? `${parts[0]}.0.0` : null;
};

/** The plain-log report. Every line is neutralized here, whatever built it. */
export function formatReport({ status, lines }) {
  return [
    'Live Expo compatibility diagnostic (informational; it does not replace the offline gate)',
    `Result: ${neutralize(status)}`,
    ...lines.map((line) => `  ${neutralize(line)}`),
  ].join('\n');
}

/** The workflow annotation line for a result that is not COMPATIBLE. */
export const annotationLine = ({ status, headline }) =>
  `::warning title=${escapeAnnotationProperty(`Live Expo compatibility ${status}`)}::${escapeAnnotationData(headline ?? status)}`;

async function evaluate({ installed, probe, cli }) {
  const installedVersion = installed ?? readInstalledExpo();
  const sdkVersion = sdkFor(installedVersion);
  if (!sdkVersion) {
    return indeterminateOutcome(
      `The installed expo version "${neutralize(installedVersion, 60)}" is not a plain version; the SDK cannot be determined.`,
    );
  }
  return classify({
    installed: installedVersion,
    sdkVersion,
    probe: await probe(sdkVersion),
    cli: cli(),
  });
}

export async function main({
  installed,
  probe = probeAdvertisedExpo,
  cli = runLiveCli,
  env = process.env,
  log = console.log,
  summaryAppend = appendFileSync,
} = {}) {
  let outcome;
  try {
    outcome = await evaluate({ installed, probe, cli });
  } catch (error) {
    // Anything unforeseen (a module that does not resolve, a command that cannot be found, a bug) is an unanswered
    // question. It must never be reported as a confirmed incompatibility, which is exit code 1.
    outcome = indeterminateOutcome(`Unexpected error: ${describeError(error)}`);
  }
  try {
    const report = formatReport(outcome);
    log(report);
    if (outcome.status !== 'COMPATIBLE') {
      // A workflow annotation, so an informational problem is visible without turning the workflow red.
      log(annotationLine(outcome));
    }
    if (env.GITHUB_STEP_SUMMARY) {
      summaryAppend(env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
    }
  } catch {
    // Reporting is a convenience; the exit code is the record, and it is already decided.
  }
  return outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
