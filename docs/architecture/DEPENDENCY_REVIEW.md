# Stage 0 dependency review

Reviewed: 2026-10-07. This is a point-in-time lockfile review, not a guarantee of dependency safety.

The authoritative per-advisory analysis and dispositions live in
[docs/security/DEPENDENCY_RISK_REGISTER.md](../security/DEPENDENCY_RISK_REGISTER.md). This file is the
stage summary and points there; it deliberately does not restate dispositions, so the two cannot diverge.

## Open high-severity advisories

| Dependency       | Path/use                                                       | Advisory                                                                 | Disposition                                                                              | Owner decision      |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| node-forge 1.4.0 | `expo` - `@expo/cli` and `@expo/code-signing-certificates`     | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | OPEN - temporarily accepted with documented non-reachability. No patched release exists. | ACCEPTED 2026-10-07 |
| braces 3.0.3     | `micromatch` - `@next/eslint-plugin-next` and `metro-file-map` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | OPEN - temporarily accepted with documented non-reachability. No patched release exists. | ACCEPTED 2026-10-07 |

Neither package is present in any deployed runtime dependency tree (API, worker, web, Control) or in the
exported mobile JavaScript bundle. Both remain installed in `node_modules` as lint/bundling tooling, so
`pnpm audit --audit-level=high` still exits non-zero. That is the correct technical result.

"Transitive" is not treated as proof of safety: the register records the enumerated call sites, the
attacker-controlled-input analysis for each, the artifact scans, the rejected remediation options, and the
review triggers that would convert either entry to BLOCKING.

The owner accepted both temporary dispositions on 2026-10-07 on the basis of that reachability analysis.
**Neither advisory is resolved or remediated.** No audit ignore, lowered threshold, replacement stub,
patched package source, or unverified fork has been used, and the CI high-severity audit gate remains
enforced and still fails. New or unreviewed high-severity findings remain unacceptable. Do not call the
audit gate green while it fails.

Standing follow-up: a future security-policy task should add a controlled mechanism for separating
reviewed temporary exceptions from new vulnerabilities without hiding the raw audit result. It was not
built during Stage 0 closure.

Next action: revalidate if a patched upstream release appears, apply it, and update the register. Re-run the
reachability analysis if any review trigger fires. Do not expose development tooling to untrusted inputs or
services in the meantime.

## Fixed advisory

[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) affected uuid 7.0.3 under Expo config-plugins - xcode. A narrowly scoped `xcode>uuid: 11.1.1` override selects the patched CommonJS-compatible version. Source inspection shows xcode consumes uuid.v4 without the affected optional buffer API. `tests/toolchain.test.mjs` verifies actual xcode ID generation through the Expo dependency chain after the override. This does not claim a complete native iOS build was tested.

## Tooling compatibility and install policy

- Expo SDK 57 pins React 19.2.3 / React Native 0.86.3; Expo validation requires React types ~19.2.4.
- NestJS 12 uses ESM; NodeNext and the Nest CLI preserve its compilation model.
- ESLint 9.39.5 is deprecated upstream but is the latest 9.x compatible with eslint-plugin-react's declared peers at review time. Upgrade when the React lint chain supports ESLint 10; do not bypass strict peers.
- Required dependency install scripts are allowlisted. The Nest donation postinstall is denied explicitly.
- pnpm recorded exact release-age exceptions for the selected Next/Expo release family. Strict release-age mode now requires deliberate review of additions.
- No database/provider credentials, production secrets, or application personal data are present in the foundation.

## Prisma Client generation ownership - CI reliability

### The incident

Hosted run [37860601281](https://github.com/ubaliringim/tsms/actions/runs/37860601281) failed `pnpm
check` with:

```
error TS6053: File 'packages/database/src/generated/prisma/client.ts' not found.
src/client.ts(2,29): error TS2307: Cannot find module './generated/prisma/client.js'
```

The run log showed `@tsms/database:build` and `@tsms/database:typecheck` each running
`prisma generate` within the same second. This was a flake, not a deterministic failure: hosted run
[37859811782](https://github.com/ubaliringim/tsms/actions/runs/37859811782), on the identical commit,
passed. The race had already been suspected since Stage 1 but had never been caught in CI.

### Confirmed root cause

The database package wrote its own generated client from two _independent_ tasks:

```json
"build":     "prisma generate && tsc -p tsconfig.json",
"typecheck": "prisma generate && tsc -p tsconfig.json --noEmit"
```

and Turbo declared only `dependsOn: ["^build"]` for both. `^build` orders a package's
**dependencies**, not its own tasks, so for `@tsms/database` neither task depended on the other.
Turbo therefore scheduled them in parallel. Both invoked `prisma generate` against the same
`src/generated/prisma` directory, and one task's `tsc` read the directory while the other was
rewriting it.

Task graph before:

```
@tsms/database#typecheck  (prisma generate + tsc --noEmit) -+  parallel, both write
@tsms/database#build      (prisma generate + tsc)         -+  src/generated/prisma
```

### Task graph after

Generation has exactly one owner, and consumers only read its output:

```
@tsms/database#db:generate  (prisma generate, cache: false)     <- sole writer
        |
        +--> @tsms/database#build      (tsc -p tsconfig.json)
        +--> @tsms/database#typecheck  (tsc -p tsconfig.json --noEmit)
```

`build` and `typecheck` now declare `dependsOn: ["^build", "db:generate"]`. Turbo runs a `dependsOn`
entry only for packages that actually define the task, so the other seven packages are unaffected.
`test` and `test:integration` reach generation transitively through `build`.

### Cache and generated-output strategy

`db:generate` is declared with `cache: false`. Generation takes roughly 150-400 ms, so the cost is
negligible, and this removes any possibility of a restored cache directory being incomplete or
stale being treated as a successful generation. That is the property this incident was about, so it
is not left to caching. `turbo run --dry=json` confirms `@tsms/database#db:generate` reports
`cache: { local: false, remote: false }` while `build` and `typecheck` keep normal caching.

The generated directory remains git-ignored, so Turbo's default inputs for `build` are the tracked
files only. `schema.prisma`, `prisma.config.ts`, and the Prisma version in `package.json` are all
tracked, so a change to any of them changes the hash and re-runs the consumers.

`prisma generate` needs no database: `prisma.config.ts` documents that the datasource URL is read
optionally and is unused by `generate` and `validate`. No migration command was added to any build,
typecheck, or generate task.

### Developer commands

All supported entry points generate automatically through Turbo and were verified from a clean
generated-output state: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm check`,
`pnpm test:integration`. `pnpm db:generate` remains the explicit manual command.

One ergonomic change: invoking the database package scripts _directly_, for example
`pnpm --filter @tsms/database typecheck`, no longer generates the client first. Run
`pnpm db:generate` first in that case. This is deliberate - keeping generation inside those scripts
is precisely what allowed two concurrent writers - and the reason is recorded in the package
`//build` and `//typecheck` script notes.

### Regression coverage

`packages/database/tests/generation.test.mjs` asserts the property structurally, so the graph fails
the build if it regresses: the database `build` and `typecheck` scripts contain no `prisma` command,
no other workspace script generates the client, `build` and `typecheck` depend on `db:generate`,
`db:generate` is uncached, no migration command was introduced, the generated directory stays
ignored, and every documented API configuration variable is present in `globalEnv`. These assertions
are structural rather than timing-based, so they cannot themselves be flaky. Reintroducing the
original defect fails two of them.

### A related cache-key defect found at the same time

`API_PASSWORD_RECOVERY_DELIVERY_MODE` and `API_PASSWORD_RECOVERY_URL_BASE` were documented in
`.env.example` and read by the API at startup, but were missing from the Turbo `globalEnv` list.
A variable that changes behaviour yet cannot change a cache key can let a stale task result be reused
across configurations. Both were added, and the regression test asserts that every documented API
configuration variable is present.
