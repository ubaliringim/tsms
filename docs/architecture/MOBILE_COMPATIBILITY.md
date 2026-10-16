# Mobile (Expo) compatibility validation

Stage 2.9. This records what the two Expo compatibility checks do, what they do not, and what must still be reviewed by
a person before production.

## Why there are two checks

`pnpm mobile:check` runs `expo install --check`. Its expected versions come from two places, read from the installed
`@expo/cli`:

1. `expo/bundledNativeModules.json`, shipped inside the **installed** `expo` package; and
2. Expo's server (`https://api.expo.dev/v2/versions/latest`), which **overrides** the first and is cached for five
   minutes. Its `expoVersion` field is the minimum `expo` patch for the SDK, for example `~57.0.30`.

The second source moves on Expo's schedule, not ours. Expo published four SDK 57 patches in nine days, and this project
adds new dependency versions only after the 24-hour release-age window. A gate that follows the second source can
therefore turn red for a reason no change in this repository caused, and cannot be fixed until the window passes. That
is not reproducible, so it cannot be a CI gate.

## The CI gate: `EXPO_OFFLINE=1 pnpm mobile:check`

`validate` runs the unchanged check with `EXPO_OFFLINE=1`. The CLI then skips the server and compares the project against
the bundled metadata of the installed `expo`, so the result depends only on the lockfile.

**What it validates.** Every dependency in `apps/student-mobile/package.json` that the installed SDK's bundled map names.
Today that is `react` and `react-native`, which must match the SDK's exact versions. A wrong `react-native` still fails.

**What it does not validate.**

- The minimum `expo` patch that Expo currently advertises. `expo` is not in the bundled map, so an installed patch that
  is behind Expo's server is invisible to this gate.
- Emergency version corrections Expo pushes through its server without releasing a new `expo` package.
- Packages the bundled map does not name (`@types/react`, `typescript`).
- Anything native: `mobile:export` proves Android JS bundling only. No device, emulator or store-signed build is
  validated.

The CLI prints "Dependency validation is unreliable in offline-mode". That is accurate and is the cost of
reproducibility, not a fault.

The developer command `pnpm mobile:check` is unchanged and stays online. Use it, and the live diagnostic below, when
deliberately bumping Expo.

## The live diagnostic: `pnpm mobile:check:live`

`scripts/expo-live-check.mjs`, run by the `expo-live-diagnostic` job. **It is informational and does not replace the
offline gate.** It runs the unchanged online check (`expo install --check --json`, with `EXPO_OFFLINE` removed) and,
independently, asks the same server endpoint which `expo` range it advertises. The second step exists because the CLI
caches responses and can fall back to local metadata, so a clean CLI result alone is not proof that a live check ran.

| Result          | Exit | Meaning                                                                                                   |
| --------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `COMPATIBLE`    | 0    | The live check ran, agreed with the probe, and nothing is below what Expo advertises.                     |
| `INCOMPATIBLE`  | 1    | A genuine finding: usually the installed `expo` patch is below the advertised minimum.                    |
| `INDETERMINATE` | 2    | Not answered: network or HTTP failure, unreadable response, the CLI failing, or the two sources disagree. |

An incompatibility is never reported as a pass, and a network failure is never reported as an incompatibility or a pass.
An unexpected exception of any kind (a module that does not resolve, a command that cannot be found, a bug) is
`INDETERMINATE` with exit 2, so a crash can never look like a confirmed incompatibility.

**Output safety.** Expo's server, the Expo CLI's stdout and stderr, dependency names and ranges, and exception messages
are untrusted. Every line is neutralized where it is emitted: control characters, escape sequences, line breaks and bidi
overrides are shown as visible escapes (for example `\n`, `\u{1b}`), `::` is broken apart so a log line cannot become a
workflow command, and long values are truncated. A workflow annotation additionally encodes `%`, and its title also `:`
and `,`. The job summary places the report in a Markdown code fence longer than any backtick run in the text, so it cannot
close the block or start a heading. Findings stay readable: ordinary text is unchanged and escaped text is still shown.
Backslashes are not escaped, so a literal `\n` in the input looks the same as an escaped line break.

The job sets `continue-on-error: true`, deliberately and on that job only, so a lagging patch does not turn the workflow
red. The result is still visible as a `::warning` annotation and in the job summary. Nothing here suppresses a result,
rewrites a version or touches the lockfile. No external service or dependency is added; the endpoint is the one the Expo
CLI already uses.

## Required before production deployment

The offline gate passing does **not** show that the installed Expo is current. Before any production deployment or store
release, a person must:

1. run `pnpm mobile:check:live` (or the online `pnpm mobile:check`) and review the result;
2. if the installed `expo` is below Expo's advertised minimum, read the Expo release notes for the skipped patches and
   either upgrade (respecting the 24-hour release-age policy, with no exclusions) or record why not;
3. treat an `INDETERMINATE` result as unanswered and repeat it, not as acceptance.

This review is a manual step; no automation records it.
