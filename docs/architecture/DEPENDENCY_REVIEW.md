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
