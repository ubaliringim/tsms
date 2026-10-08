# Dependency risk register

Owner: TeamStack Technologies LTD
Stage: 1 - Database & Local Infrastructure (implementation authorized 2026-10-07; Stage 0 accepted)
Last analysis: 2026-10-07
Last owner decision: 2026-10-07 (Stage 0 dispositions)
Analysed lockfile: `pnpm-lock.yaml` (pnpm 12.3.4, Node 24.16.0)

This register is the authoritative record of TSMS dependency-security dispositions. It supersedes the
summary table in `docs/architecture/DEPENDENCY_REVIEW.md`, which now links here rather than duplicating
dispositions.

## Owner decisions of record

| Date       | Advisories                             | Decision | Resulting state                                              | Remediated/Resolved |
| ---------- | -------------------------------------- | -------- | ------------------------------------------------------------ | ------------------- |
| 2026-10-07 | GHSA-86w9-cpqp-85rv (node-forge 1.4.0) | ACCEPTED | OPEN - temporarily accepted with documented non-reachability | **No / No**         |
| 2026-10-07 | GHSA-vfj7-8cjw-p6xm (braces 3.0.3)     | ACCEPTED | OPEN - temporarily accepted with documented non-reachability | **No / No**         |

Both packages remain installed and both vulnerable code paths remain present on disk. The owner accepted
the risk on the basis of the reachability analysis recorded in this register; neither advisory was fixed,
suppressed, or resolved.

## How to read this register

Dispositions use three states. They are not interchangeable.

- **RESOLVED** - the vulnerable code is no longer installed. Requires a lockfile change and a passing
  `pnpm audit --audit-level=high`. A package that is still installed is never RESOLVED, regardless of how
  unreachable its vulnerable code is.
- **OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY** - the vulnerable code is still
  installed, but every TSMS-owned call path that could reach the vulnerable functionality has been
  enumerated by source inspection, and the attacker-controlled-input precondition is not satisfiable in a
  deployed TSMS environment. This requires a named owner review and a review trigger.
- **BLOCKING** - the vulnerable code is installed and either reachable with attacker-controlled input, or
  no acceptable disposition can be justified.

## Register summary

| ID                  | Package      | Version | Severity | Workspace(s)                          | Runtime class                                        | Disposition                                                  | Owner decision                                  |
| ------------------- | ------------ | ------- | -------- | ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| GHSA-86w9-cpqp-85rv | node-forge   | 1.4.0   | High     | `@tsms/student-mobile`                | mobile bundling/build tooling (not runtime)          | OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY | ACCEPTED 2026-10-07                             |
| GHSA-vfj7-8cjw-p6xm | braces       | 3.0.3   | High     | `tsms` (root), `@tsms/student-mobile` | lint tooling + mobile bundling tooling (not runtime) | OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY | ACCEPTED 2026-10-07                             |
| GHSA-ggr8-5vv4-36mx | deepmerge-ts | 8.0.2   | High     | `@tsms/database` (via Prisma CLI)     | build/CLI tooling                                    | RESOLVED (scoped override; patched version installed)        | n/a - remediated by agent, no acceptance needed |
| GHSA-3f6p-5ww8-9rcr | mysql2       | 3.24.5  | High     | `@tsms/database` (via Prisma CLI)     | build/CLI tooling                                    | RESOLVED (scoped override; patched version installed)        | n/a - remediated by agent, no acceptance needed |
| GHSA-rgwj-5xj2-c3m3 | mysql2       | 3.24.5  | Moderate | `@tsms/database` (via Prisma CLI)     | build/CLI tooling                                    | RESOLVED (scoped override; patched version installed)        | n/a - remediated by agent, no acceptance needed |
| GHSA-w5hq-g745-h8pq | uuid         | 11.1.1  | (fixed)  | via Expo config-plugins               | build tooling                                        | RESOLVED (scoped override `xcode>uuid: 11.1.1`)              | n/a                                             |

`pnpm audit --audit-level=high` still exits non-zero with two high findings. That remains the correct technical
result and is reported as FAIL. See "Audit policy" below.

## Stage 1 advisory remediation (2026-10-07)

Adding `prisma@7.10.0` for the database package introduced three advisories that did not exist in the Stage 0
baseline. All three were **remediated rather than accepted**, because each had a patched upstream release. The
Stage 0 owner acceptance does not extend to them and was not relied on.

| Advisory                                                                 | Package      | Introduced | Patched range | Override applied                       | Now installed |
| ------------------------------------------------------------------------ | ------------ | ---------- | ------------- | -------------------------------------- | ------------- |
| [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) | deepmerge-ts | 7.1.5      | `>= 8.0.0`    | `'@prisma/config>deepmerge-ts': 8.0.2` | 8.0.2         |
| [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) | mysql2       | 3.15.3     | `>= 3.22.0`   | `'prisma>mysql2': 3.24.5`              | 3.24.5        |
| [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3) | mysql2       | 3.15.3     | `>= 3.23.1`   | `'prisma>mysql2': 3.24.5`              | 3.24.5        |

CVE assignments: CVE-2026-40345 for GHSA-ggr8-5vv4-36mx. GHSA-3f6p-5ww8-9rcr has no assigned CVE.
GHSA-rgwj-5xj2-c3m3 is a separate `mysql2` finding; confirm its CVE assignment in the advisory record before citing
one.

Exact dependency chains, verified with `pnpm why -r` after the overrides:

```
deepmerge-ts@8.0.2
└─ @prisma/config@7.10.0   (pins deepmerge-ts = "7.1.5", an exact version)
   └─ prisma@7.10.0
      ├─ @prisma/client@7.10.0  → @tsms/database (dependencies)
      └─ @tsms/database (devDependencies)

mysql2@3.24.5
└─ prisma@7.10.0            (pins mysql2 = "3.15.3", an exact version)
   ├─ @prisma/client@7.10.0  → @tsms/database (dependencies)
   └─ @tsms/database (devDependencies)
```

All three arrive through `packages/database`: `prisma@7.10.0` pins `mysql2` to `3.15.3` and
`@prisma/config@7.10.0` pins `deepmerge-ts` to `7.1.5`, both as exact versions, so resolution could not be
influenced from the workspace. Scoped `overrides` in `pnpm-workspace.yaml` are the established remedy in this
repository (see the existing `xcode>uuid` override).

**Vulnerability summaries.** `deepmerge-ts` before 8.0.0 has no cycle detection in its recursive record merging, so
two self-referencing objects merged at the same property path recurse until `RangeError: Maximum call stack size
exceeded` (CVE-2026-40345, CWE-674, CVSS 8.2). `mysql2` before 3.22.0 accepts a rogue-server `AuthSwitchRequest`
to `mysql_clear_password` and returns the password in plaintext without verifying TLS is active (CWE-522,
CVSS 8.2). GHSA-rgwj-5xj2-c3m3 is a separate `mysql2` finding fixed in 3.23.1.

**Compatibility assessment for the deepmerge-ts major bump (7 → 8).** `@prisma/config` imports exactly one symbol
from this package: `const { deepmerge } = await import("deepmerge-ts")`, used as c12's config merger
(`@prisma/config/dist/index.js:621` and `:644`). deepmerge-ts 8.0.0's documented breaking changes are: Map values
are now deep-merged by default; `DeepMergeMetaMetaData` renamed to `DeepMergeMergeInfo` (deprecated alias kept);
`DeepMergeIntoFunctionUtils` renamed to `DeepMergeIntoUtils`; and `deepmergeInto` no longer leak-mutates its input.
None of those apply to the `deepmerge(a, b, ...)` call c12 makes over plain configuration objects, and the
`deepmerge` signature is unchanged. 8.x additionally adds the circular-reference handling that is the fix.

**Verification performed after the overrides.** `prisma validate`, `prisma generate`, `prisma format --check`,
`prisma migrate status`, `prisma migrate deploy` against the disposable test database, `pnpm install
--frozen-lockfile`, the full `pnpm check` suite, `pnpm test:integration`, `pnpm smoke`, `pnpm mobile:check`, and
`pnpm mobile:export` all pass. `pnpm audit --audit-level=high` returns to exactly the Stage 0 baseline of two high
findings with `Patched versions: None`. `pnpm why -r` confirms a single resolved version of each package.

**Proof that no vulnerable version remains installed through another path.** An advisory must not be called
remediated while a vulnerable copy is still present, so this was checked three independent ways at closure:

1. `pnpm why -r` reports exactly one version of each: `deepmerge-ts@8.0.2` and `mysql2@3.24.5`.
2. `pnpm-lock.yaml` contains no reference to `deepmerge-ts@7.1.5` or `mysql2@3.15.3`; its snapshots list only
   `deepmerge-ts@8.0.2` and `mysql2@3.24.5`.
3. A symlink walk of every `node_modules` directory in the workspace found **zero** references to the pre-override
   virtual-store directories. Two orphaned copies (`deepmerge-ts@7.1.5`, `mysql2@3.15.3`) had been left on disk by
   an earlier install; they were linked from no workspace package and were removed, after which
   `pnpm install --frozen-lockfile` and the audit were re-verified.

By contrast, `node-forge@1.4.0` and `braces@3.0.3` are genuinely installed and reachable, which is why their
dispositions remain OPEN and unresolved.

**Not done, deliberately:** no third-party source was patched, no fork was adopted, and no advisory was suppressed.
The overrides select published, patched upstream releases.

### Override scope, narrowed at closure (2026-10-07)

Stage 1 applied these as **global** overrides (`deepmerge-ts: 8.0.2`, `mysql2: 3.24.5`). The closure review narrowed
both to their introducing parent:

```yaml
overrides:
  '@prisma/config>deepmerge-ts': 8.0.2
  'prisma>mysql2': 3.24.5
```

Rationale: each package enters the graph only through the one Prisma parent, so a parent-scoped override has the
same effect today while guaranteeing that a future unrelated consumer of `deepmerge-ts` or `mysql2` is **not**
silently upgraded. Resolution, `pnpm why`, the Prisma CLI, the full test suite, integration tests, mobile
validation, and the audit were all re-verified after narrowing, with identical results.

**When to remove each override:** as soon as its Prisma parent ships an already-patched version -
`@prisma/config` pinning `deepmerge-ts >= 8.0.0`, and `prisma` pinning `mysql2 >= 3.23.1`. Do not upgrade Prisma
solely to clean these up; the current secure versions work and the audit is clear.

**Re-evaluation triggers:** `prisma`, `@prisma/client`, `@prisma/config`, or `@prisma/adapter-pg` is upgraded or
downgraded; either override is edited or removed; Prisma adds datasource support for something TSMS actually
uses, which would change the `mysql2` reachability assessment; or `pnpm audit` reports either advisory again.

**Residual risk.** Both overrides still sit ahead of Prisma's own exact pins. If a future Prisma release depends on
behaviour introduced in `deepmerge-ts` 7.x or `mysql2` 3.15.x, the override could mask that. Revisit on every
Prisma upgrade.

**Review triggers for these two entries.** `prisma`, `@prisma/client`, `@prisma/adapter-pg`, or `@prisma/config`
is upgraded **or downgraded**; the `deepmerge-ts` or `mysql2` overrides are removed or changed; Prisma begins
supporting a datasource TSMS actually uses, which would change the reachability assessment of `mysql2`; or
`pnpm audit` reports either advisory again.

## Audit policy

The following policy is in force and is not modified by the owner acceptance above.

1. **The technical audit status remains failing.** `pnpm audit --audit-level=high` exits non-zero with two
   high-severity findings, both with `Patched versions: None`. It is reported as FAIL in every record. It
   is never reported as PASS.
2. **Neither advisory is suppressed.** No `pnpm.auditConfig.ignoreCves` entry, no `.npmrc` audit setting,
   no advisory ignore list, and no threshold change exists. The CI step `pnpm audit --audit-level=high`
   in `.github/workflows/ci.yml` is unchanged.
3. **The severity threshold is not lowered.** `--audit-level=high` stands.
4. **No broad ignore rules.** Nothing in the repository excludes a class of advisories.
5. **The two accepted findings are individually dispositioned.** They are accepted by ID
   (GHSA-86w9-cpqp-85rv, GHSA-vfj7-8cjw-p6xm) with named review triggers, not by category. Any other
   advisory - including any new high or critical finding - remains unacceptable and blocking.
6. **A future security-policy task should add a controlled mechanism** for distinguishing reviewed
   temporary exceptions from genuinely new vulnerabilities, while still surfacing the raw audit result
   and still failing on unreviewed findings. Such a mechanism must be additive: it may annotate or
   summarise reviewed exceptions, but it must never hide the raw `pnpm audit` output or convert a new
   finding into a pass.

No such mechanism was built during Stage 0 closure or Stage 1 closure. Nothing in the existing Stage 0
tooling supports it cleanly today. `.github/workflows/ci.yml` runs the raw audit as its own step in a
dedicated `security-audit` job.

### Why the audit lives in a separate CI job

`pnpm audit --audit-level=high` exits non-zero because of the two owner-accepted advisories above, and it
will keep doing so until upstream publishes a patch. Keeping that step in the functional `validate` job
would make every red run ambiguous: it would be impossible to tell a real regression from the known gate.

The audit therefore runs in a separate `security-audit` job. **This is a distinction, not a suppression:**

- the command is unchanged: `pnpm audit --audit-level=high`
- there is no `continue-on-error`, no `|| true`, and no advisory ignore list
- the threshold is unchanged
- no severity is downgraded and no advisory is excluded
- the step still fails, its job is still red, and the workflow overall is still red

What the split buys is attribution: a failure in `validate` is a functional regression, and a failure in
`security-audit` is the known security-policy gate. Neither can hide the other.

An operator who wants a red workflow to mean "something is genuinely wrong" must treat the `security-audit`
failure as a known, accepted, and still-tracked condition until upstream ships a fix or the owner changes the
disposition.

---

## GHSA-86w9-cpqp-85rv - node-forge RSA PKCS#1 v1.5 signature forgery

### Advisory identity

| Field                | Value                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory ID          | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)                                                                      |
| CVE                  | CVE-2026-85393                                                                                                                                |
| Package / version    | `node-forge@1.4.0`                                                                                                                            |
| Severity             | High, CVSS v4 8.7 (`CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N`)                                                         |
| Weakness             | CWE-347 Improper Verification of Cryptographic Signature                                                                                      |
| Affected versions    | `<= 1.4.0`                                                                                                                                    |
| Patched versions     | **None** - verified against the npm registry at analysis time; `node-forge` latest published version is `1.4.0`                               |
| Upstream predecessor | [GHSA-ppp5-5v6c-4jwp](https://github.com/advisories/GHSA-ppp5-5v6c-4jwp) / CVE-2026-33894. This advisory is an incomplete fix for that issue. |

### Vulnerable functionality

`node-forge@1.4.0` `lib/rsa.js` `key.verify()` under the default `RSASSA-PKCS1-V1_5` scheme parses the
attacker-supplied `DigestInfo` ASN.1 structure and checks the **outer** SEQUENCE element count only:

- `node_modules/.pnpm/node-forge@1.4.0/node_modules/node-forge/lib/rsa.js:1174-1175` -
  `asn1.validate(obj, digestInfoValidator, capture, errors) || obj.value.length !== 2`
- `node_modules/.pnpm/node-forge@1.4.0/node_modules/node-forge/lib/rsa.js:273-293` - the nested
  `DigestInfo.DigestAlgorithm` validator matches a _prefix_ of children and performs **no** element-count
  check of its own.

Extra garbage elements appended inside the nested `DigestAlgorithm` SEQUENCE are therefore ignored while
`capture.digest` is still accepted, allowing a forged `DigestInfo` to satisfy
`digest === capture.digest` (`lib/rsa.js:1212`) for arbitrary messages when the verifier's RSA key has a
low public exponent. The affected function is specifically **PKCS#1 v1.5 signature verification**.
`privateKey.sign()` and `certificateFromPem()` parsing are not the affected operations.

### Dependency chain

Two direct dependents of `node-forge`, both inside `@expo/cli`:

```
node-forge@1.4.0
├─ @expo/cli@57.0.28                     (dependencies: "node-forge": "^1.3.3")
│  └─ expo@57.0.27                       (dependencies: "@expo/cli": "^57.0.28")
│     └─ @tsms/student-mobile@0.0.0      (dependencies)
└─ @expo/code-signing-certificates@0.0.6 (dependencies: "node-forge": "^1.3.3")
   └─ @expo/cli@57.0.28                  (dependencies: "@expo/code-signing-certificates": "^0.0.6")
```

Evidence: `artifacts/stage0-risk/why-node-forge.json` (inherited), reproduced with
`pnpm why -r node-forge` and `pnpm why --prod node-forge`.

### Workspace and classification

- Introducing workspace: **`@tsms/student-mobile`** (`apps/student-mobile`), as a transitive dependency of
  `expo@57.0.27`.
- Not present in `@tsms/api`, `@tsms/worker`, `packages/config`, `@tsms/web`, or `@tsms/control`
  production dependency trees (verified with `pnpm --filter <pkg> list --prod --depth 30`).
- `pnpm why --prod node-forge` does report node-forge, because `expo` declares `@expo/cli` in
  **regular** `dependencies` rather than `devDependencies`. **This is not evidence of runtime
  exploitability**: `@expo/cli` is a Node.js build/dev tool that runs on the developer or CI machine. It is
  installed into the mobile app's `node_modules` because Expo tooling is a hard requirement of
  `expo start` / `expo export`, but it is not application code and is not shipped inside the app.

Classification:

| Environment                              | node-forge present/reachable              |
| ---------------------------------------- | ----------------------------------------- |
| Deployed production runtime (API/worker) | Absent                                    |
| Deployed Next.js runtime (web/control)   | Absent                                    |
| Mobile app runtime bundle                | Absent (see artifact evidence)            |
| Mobile bundling tooling (`expo export`)  | Present in `node_modules`, not bundled    |
| iOS native prebuild tooling (macOS only) | Present in `node_modules`, parse-only use |
| Test tooling                             | Absent                                    |

### TSMS call-site and reachability analysis

`@expo/cli` was scanned for node-forge usage (403 `.js`/`.cjs`/`.mjs` source files). Exactly one file
references `node-forge` directly, and one file imports `@expo/code-signing-certificates`:

1. **`@expo/cli/build/src/run/ios/codeSigning/Security.js:70`** - `nodeForge.pki.certificateFromPem(pem)`.
   **Parsing only, no signature verification.** Reached only from
   `run/ios/codeSigning/configureCodeSigning.js` and `resolveCertificateSigningIdentity.js`, which shell out
   to the macOS `security` binary. TSMS never runs `expo run:ios` / `expo prebuild` in any validated
   pipeline (only `expo install --check` and `expo export --platform android`), and this path is
   macOS-only. **Not a PKCS#1 v1.5 verification call site.**

2. **`@expo/code-signing-certificates/build/main.js`** is the only place that calls the affected
   verification primitives:
   - `validateSelfSignedCertificate()` -> `certificate.verify(certificate)` at `main.js:176`
   - `signBufferRSASHA256AndVerify()` -> `certificate.publicKey.verify(digest.digest().getBytes(), digestSignature)` at `main.js:203`

   Call chain into the Expo CLI:

   ```
   ExpoGoManifestHandlerMiddleware.js:115   const expectSignature = req.headers['expo-expect-signature'];
   ExpoGoManifestHandlerMiddleware.js:152   await getCodeSigningInfoAsync(exp, requestOptions.expectSignature, this.options.privateKeyPath)
   utils/codesigning.js:173-176             if (!expectSignatureHeader) { return null; }        <-- gate
   utils/codesigning.js:308                 validateSelfSignedCertificate(certificate, {...})
   utils/codesigning.js:401                 signBufferRSASHA256AndVerify(privateKey, certificate, ...)
   ```

   Reachability requires **all** of the following, none of which holds in TSMS:

   - It is the **Expo Go / dev-client manifest middleware**, which only runs under `expo start`. TSMS's
     validated mobile commands are `expo install --check` and `expo export --platform android`;
     `expo export` does not serve manifests through this middleware.
   - The requesting client must send an `expo-expect-signature` header
     (`ExpoGoManifestHandlerMiddleware.js:115`). Without it `getCodeSigningInfoAsync` returns `null` at
     `utils/codesigning.js:174` and neither verification function runs.
   - `validateSelfSignedCertificate` additionally requires `updates.codeSigningCertificate` and
     `updates.codeSigningMetadata` in the resolved app config **plus** an explicit `--private-key-path`
     CLI flag (`utils/codesigning.js:258-281`, `:265-267`).
   - `apps/student-mobile/app.json` contains only `name`, `slug`, `version`, `orientation`, and
     `userInterfaceStyle`. There is **no** `updates` block, **no** `updates.codeSigningCertificate`,
     **no** `updates.codeSigningMetadata`, **no** `extra.eas.projectId`, and there is **no** `eas.json` in
     the repository.

### Attacker-controlled-input exposure

Not reachable in a deployed TSMS environment. Specifically:

- No network-facing TSMS service loads `@expo/cli`. The API (NestJS) and worker do not depend on it at all;
  the Next.js apps do not. `@expo/cli` runs only in developer/CI shells.
- The certificate consumed by `validateSelfSignedCertificate` is read from a **developer-controlled local
  file** path (`readFileWithErrorAsync(codeSigningCertificatePath, ...)`, `utils/codesigning.js:294-299`
  and `:301-316`), not from a request body, tenant record, upload, or remote client.
- The signature consumed by `signBufferRSASHA256AndVerify` is **generated in-process microseconds earlier**
  by the same function from the same local private key (`utils/codesigning.js:398-402`). There is no
  attacker-supplied signature anywhere in the flow.
- The `expo-expect-signature` header value only selects which code-signing key to use and is compared
  against locally configured values; it is not used as verification input.
- No TSMS-authored source imports `node-forge` or performs any RSA/PKCS#1 v1.5 verification. A repository
  scan of `apps/**` and `packages/**` for `node-forge`, `rsa.`, `.verify(`, `createVerify`, `createSign`
  returns no matches.

Residual theoretical exposure, stated honestly: if a developer later enables EAS Update code signing,
the certificate chain fetched from the Expo API for the cached development-certificate path is not
cryptographically verified by the CLI (`validateStoredDevelopmentExpoRootCertificateCodeSigningInfo`,
`utils/codesigning.js:320-345`, checks validity dates only). A forge of the Expo HTTPS endpoint could
therefore inject a certificate. That endpoint is not in scope for the verified call sites because
`validateSelfSignedCertificate` operates on local files only, but this is recorded as a forward risk and is
one of the review triggers below.

### Deployment artifact exposure

Byte-level scans of every generated artifact found **no** node-forge content:

| Artifact                                                          | Files scanned   | `node-forge` | `pki.rsa` | `RSA PKCS#1 v1_5` |
| ----------------------------------------------------------------- | --------------- | ------------ | --------- | ----------------- |
| `apps/student-mobile/dist/_expo/static/js/android/*.hbc` (Hermes) | 1 (1 429 521 B) | absent       | absent    | absent            |
| `apps/student-mobile/dist/metadata.json`                          | 1               | absent       | absent    | absent            |
| `apps/web/.next`                                                  | 154             | absent       | absent    | absent            |
| `apps/control/.next`                                              | 154             | absent       | absent    | absent            |
| `apps/api/dist`                                                   | 12              | absent       | absent    | absent            |
| `apps/worker/dist`                                                | 6               | absent       | absent    | absent            |

node-forge is installed into `node_modules` on the developer/CI machine (and would be installed in an EAS
build environment) as an input to producing the bundle. It is **not** part of any shipped artifact.

### Available remediation

| Option                                                  | Assessment                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade to a patched `node-forge`                       | **Not available.** Registry lists `1.4.0` as latest; advisory lists no patched version.                                                                                                         |
| Override to a fixed fork                                | **Rejected.** Would be an unverified third-party source. Not permitted and not done.                                                                                                            |
| Patch installed package source / `patch-package`        | **Rejected.** Prohibited by task constraints; would not survive a lockfile-only install anyway.                                                                                                 |
| Remove `@expo/code-signing-certificates` / `node-forge` | **Not possible** without forking `@expo/cli` or the `expo` package.                                                                                                                             |
| Move `expo` from `dependencies` to `devDependencies`    | **Rejected as ineffective.** `@expo/cli` still requires `node-forge`, so the package would still be installed and still audited. It would also misrepresent Expo's supported dependency layout. |
| Configure `pnpm audit` / CI to ignore the advisory      | **Rejected.** Explicitly prohibited; would produce a false green gate.                                                                                                                          |

**Remediation attempts made during this task:** none were applied. Registry version listings were checked
(`npm view node-forge versions`), package `dependencies` blocks were read to confirm the chain, and the
removal/override options above were evaluated. No lockfile, workspace, or CI change was made for this
advisory.

### Compensating controls

- The verified verification call sites require developer/EAS-provisioned code-signing material and are not
  reachable through any network-facing TSMS component.
- No shipped artifact contains node-forge code, so a compromised bundle cannot be used as a carrier.
- Development tooling is never exposed to untrusted inputs or network services (no CI step, script, or
  hook feeds external data into `expo start` with `expo-expect-signature`).
- `minimumReleaseAgeStrict`, `strictPeerDependencies`, and the `allowBuilds` allowlist remain enabled in
  `pnpm-workspace.yaml`, limiting the blast radius of future transitive additions.
- The CI high-severity audit gate remains enabled and still fails, so this advisory cannot silently return.

### Current disposition

**OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY**

| Field                            | Value                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner decision                   | **ACCEPTED**                                                                                                                                                                   |
| Decided by                       | Project owner (TeamStack Technologies LTD)                                                                                                                                     |
| Decision date                    | 2026-10-07                                                                                                                                                                     |
| Decision basis                   | The existing reachability analysis recorded in this register: enumerated call sites, attacker-input analysis, deployment-artifact scans, and the rejected remediation options. |
| Reached state                    | OPEN - temporarily accepted with documented non-reachability                                                                                                                   |
| Remediated?                      | **No**                                                                                                                                                                         |
| Resolved?                        | **No**                                                                                                                                                                         |
| Package still installed          | **Yes** - `node-forge@1.4.0`                                                                                                                                                   |
| Vulnerable code still on disk    | **Yes** - `lib/rsa.js` PKCS#1 v1.5 verification path                                                                                                                           |
| Patched upstream release exists? | **No**                                                                                                                                                                         |
| Reconsideration                  | Mandatory if any review trigger in this entry occurs                                                                                                                           |

**This is not remediation and not resolution.** `node-forge@1.4.0` remains installed, the vulnerable
`lib/rsa.js` code is present on disk, and no patched upstream release exists. No suppressive measure was
applied: the advisory is not suppressed, the audit threshold is not lowered, no fork or patched package was
introduced, and `pnpm audit --audit-level=high` still exits non-zero and is still reported as FAIL.

The acceptance rests on documented non-reachability of the PKCS#1 v1.5 verification primitive from every
TSMS-owned code path and deployment artifact, not on an assumption that "transitive means safe". If any
review trigger below fires, or if the reachability analysis is ever shown to be wrong, this disposition
reverts to BLOCKING without any dependency change being required.

### Evidence

- `artifacts/stage0-risk/why-node-forge.json` - inherited `pnpm why` dependency tree
- `artifacts/stage0-risk/locations.json` - inherited on-disk package locations
- `pnpm why -r node-forge` and `pnpm why --prod node-forge`
- `pnpm --filter @tsms/api list --prod --depth 30`, `pnpm --filter @tsms/worker list --prod --depth 30`
- Direct source reads:
  `node_modules/.pnpm/@expo+cli@57.0.28_.../node_modules/@expo/cli/build/src/run/ios/codeSigning/Security.js`,
  `.../@expo/cli/build/src/utils/codesigning.js`,
  `.../@expo/cli/build/src/start/server/middleware/ExpoGoManifestHandlerMiddleware.js`,
  `node_modules/.pnpm/@expo+code-signing-certificates@0.0.6/node_modules/@expo/code-signing-certificates/build/main.js`,
  `node_modules/.pnpm/node-forge@1.4.0/node_modules/node-forge/lib/rsa.js`
- `apps/student-mobile/app.json` (no `updates` / EAS code-signing configuration)
- Repository grep over `apps/**` for node-forge / RSA / signature-verification usage

### Review triggers

Re-analyse this entry immediately if any of the following occurs:

1. `node-forge` publishes a release above `1.4.0`, or digitalbazaar/forge resolves
   [forge#1149](https://github.com/digitalbazaar/forge/issues/1149) /
   [forge#1152](https://github.com/digitalbazaar/forge/issues/1152) in a tagged release.
2. `expo`, `@expo/cli`, or `@expo/code-signing-certificates` is updated, or TSMS adopts `expo run:ios`,
   `expo prebuild`, EAS Update code signing (`updates.codeSigningCertificate`,
   `updates.codeSigningMetadata`, `--private-key-path`), `extra.eas.projectId`, or `eas.json`.
3. Any TSMS component begins importing `expo`, `@expo/cli`, or `node-forge` directly, or begins performing
   RSA/PKCS#1 v1.5 verification of data received from a client, tenant, upload, or third-party API.
4. A deployed TSMS service ever loads `@expo/cli` at runtime (for example a container that runs `expo start`).
5. `pnpm audit` stops reporting this advisory (verify whether the package was removed or the audit
   configuration changed; either way, re-verify rather than assume a fix).

**Any of these triggers voids the 2026-10-07 owner acceptance above** and requires a fresh reachability
analysis plus a new owner decision. The disposition reverts to BLOCKING in the interim.

---

## GHSA-vfj7-8cjw-p6xm - braces stack-exhaustion denial of service

### Advisory identity

| Field             | Value                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Advisory ID       | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)                                    |
| CVE               | CVE-2026-93687                                                                                              |
| Package / version | `braces@3.0.3`                                                                                              |
| Severity          | High, CVSS v4 8.7 (`CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N`)                       |
| Weakness          | CWE-674 Uncontrolled Recursion                                                                              |
| Affected versions | `<= 3.0.3`                                                                                                  |
| Patched versions  | **None** - verified against the npm registry at analysis time; `braces` latest published version is `3.0.3` |
| Reference         | [micromatch/braces#70](https://github.com/micromatch/braces/issues/70)                                      |

### Vulnerable functionality

`braces@3.0.3` builds an AST (`lib/parse.js`) and then walks it recursively without any depth guard:

- `node_modules/.pnpm/braces@3.0.3/node_modules/braces/lib/parse.js:37-40` - the only guard is a **length**
  check against `MAX_LENGTH` (confirmed `MAX_LENGTH === 10000`, `lib/constants.js`). There is no depth guard.
- `node_modules/.pnpm/braces@3.0.3/node_modules/braces/lib/compile.js:48-52` - recursive `walk(child, node)`
  over `node.nodes`.
- `node_modules/.pnpm/braces@3.0.3/node_modules/braces/lib/expand.js:102-104` - recursive `walk(child, node)`
  over `child.nodes`.

A pattern with deeply nested brace groups therefore produces a recursion depth proportional to nesting
depth and can terminate the Node.js process with an uncaught `RangeError: Maximum call stack size exceeded`.

Empirical probe performed locally (Node 24.16.0, Windows, default stack):

| Input                                                                                    | Result                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `braces.compile('apps/web/')`, `braces.compile('**/*')`, `braces.compile('**/*.js')`     | ok                                                 |
| `braces.expand` / `micromatch.parse` / `micromatch.some` on the same brace-free patterns | ok                                                 |
| 1500-level nested-comma pattern, 9 391 chars (below `MAX_LENGTH`), default stack         | ok (stack survived)                                |
| same input, `node --stack-size=600`                                                      | ok                                                 |
| same input, `node --stack-size=200`                                                      | **`RangeError: Maximum call stack size exceeded`** |

Honest reading: the missing depth guard is real and was reproduced, but whether a given maximum-length
input exhausts the stack is stack-size dependent. On this host's default Node stack the deepest
constructible input did not crash. This is a genuine DoS weakness, not a guaranteed one-shot kill on every
configuration.

### Dependency chain

`braces@3.0.3` has exactly one direct dependent, `micromatch@4.0.8` (`"braces": "^3.0.3"`, and `4.0.8` is
the current `micromatch` latest). `micromatch` has three consumer paths in this workspace:

```
braces@3.0.3
└─ micromatch@4.0.8
   ├─ fast-glob@3.3.1
   │  └─ @next/eslint-plugin-next@16.4.0
   │     └─ eslint-config-next@16.4.0
   │        └─ tsms@0.0.0                      (devDependencies)
   ├─ metro-file-map@0.84.5
   │  └─ @expo/metro@56.0.2
   │     └─ @expo/cli@57.0.28
   │        └─ expo@57.0.27
   │           └─ @tsms/student-mobile@0.0.0    (dependencies)
   │     (also reachable via metro@0.84.5, metro-config@0.84.5, metro-transform-worker@0.84.5, @expo/metro-config@57.0.13)
   └─ metro-file-map@0.84.6
      └─ metro@0.84.6
         └─ @react-native/community-cli-plugin@0.86.3
            └─ react-native@0.86.3
               └─ @tsms/student-mobile@0.0.0    (dependencies)
         (also reachable via metro-config@0.84.6, metro-transform-worker@0.84.6)
```

Evidence: `artifacts/stage0-risk/why-braces.json` (inherited), reproduced with
`pnpm why -r braces` and `pnpm why -r braces --json`.

### Workspace and classification

Introducing workspaces: **`tsms`** (root, via `eslint-config-next` in `devDependencies`) and
**`@tsms/student-mobile`** (via `expo` and `react-native` in `dependencies`).

Neither package is in any deployed runtime tree: `@tsms/api`, `@tsms/worker`, `packages/config`,
`@tsms/web`, and `@tsms/control` production dependency trees were enumerated and contain no `braces`,
`micromatch`, `fast-glob`, or `picomatch`. In particular the `next@16.4.0` **runtime** package declares
only `@next/env`, `@swc/helpers`, `baseline-browser-mapping`, `caniuse-lite`, `postcss`, and `styled-jsx` -
no glob engine. `@next/eslint-plugin-next` is lint-only.

| Environment                              | braces present/reachable                                |
| ---------------------------------------- | ------------------------------------------------------- |
| Deployed production runtime (API/worker) | Absent                                                  |
| Deployed Next.js runtime (web/control)   | Absent                                                  |
| Mobile app runtime bundle                | Absent                                                  |
| Mobile bundling tooling (`expo export`)  | Present in `node_modules`, bundled output is brace-free |
| Lint tooling (`pnpm lint`)               | Present and executed                                    |

### TSMS call-site and reachability analysis

Only two files in the entire reachable tree import a glob engine, and both pass **static,
brace-free patterns**:

1. **Lint tooling.**
   `node_modules/.pnpm/@next+eslint-plugin-next@16_.../node_modules/@next/eslint-plugin-next/dist/utils/get-root-dirs.js:11`
   imports `fast-glob` and calls `fastGlob.globSync(rootDir.replace(/\\/g, '/'), { onlyDirectories: true })`.
   The `rootDir` value comes only from `context.settings.next.rootDir`. In this repository that value is a
   hard-coded literal in `eslint.config.mjs:38-39`:
   - `{ files: ['apps/web/**/*.{ts,tsx}'], settings: { next: { rootDir: 'apps/web/' } } }`
   - `{ files: ['apps/control/**/*.{ts,tsx}'], settings: { next: { rootDir: 'apps/control/' } } }`

   Neither literal contains `{` or `}`, so brace expansion is a no-op and the recursive walkers are never
   entered with attacker input. Verified by direct probe: `braces.compile('apps/web/')` and
   `micromatch.some('a/b.ts', 'apps/web/')` both return normally.

2. **Mobile bundling tooling.**
   `node_modules/.pnpm/metro-file-map@0.84.{5,6}_.../node_modules/metro-file-map/src/watchers/common.js:14`
   imports `micromatch` and implements `includedByGlob(type, globs, dot, relativePath)` using
   `micromatch.some(relativePath, globs, { dot })` (`common.js:23-30`).

   The `globs` come from Metro's `watchFolders` / `resolver.sourceExts` / `blockList` / `watchFolders`
   configuration. **TSMS supplies no such configuration**: the repository contains no `metro.config.js`,
   no `metro.config.ts`, and no `babel.config.js` (verified). Metro therefore runs the default
   `@expo/metro-config` configuration, whose patterns are upstream constants. The only other `micromatch`
   argument on that path is the relative path of a file already present on the local filesystem being
   crawled - a path, not a pattern - and paths containing braces are not attacker-supplied in TSMS.

   Note that `micromatch.parse` (`node_modules/.pnpm/micromatch@4.0.8/node_modules/micromatch/index.js:427`)
   does call `braces(String(pattern), options)` for **every** pattern; `braces` then short-circuits
   internally when the pattern has no brace group. The crash requires a pattern that actually contains
   nested braces, and no such pattern exists on any TSMS path.

### Attacker-controlled-input exposure

Not reachable in a deployed TSMS environment:

- No TSMS service, route, GraphQL resolver, background job, upload handler, export, or cache key accepts a
  glob or brace pattern from a client. A repository scan of `apps/**` for `glob`, `micromatch`,
  `fast-glob`, `braces`, and `picomatch` returns **no** matches (the only `glob` substring hits are the
  `./globals.css` imports in `apps/web/app/layout.tsx` and `apps/control/app/layout.tsx`).
- The two live call sites receive patterns from committed configuration files, not from request data.
- `braces` and `micromatch` are absent from every deployed runtime dependency tree, so no network-reachable
  TSMS process loads the vulnerable code at all. Availability impact is therefore limited to a developer or
  CI machine losing a Metro or ESLint process, and even that requires modifying committed config or
  checked-in filenames first.

### Deployment artifact exposure

Byte-level scans found **no** braces or micromatch content:

| Artifact                                                 | Files scanned   | `braces` | `micromatch` | `fillRange` | `EXPAND_RANGE` |
| -------------------------------------------------------- | --------------- | -------- | ------------ | ----------- | -------------- |
| `apps/student-mobile/dist/_expo/static/js/android/*.hbc` | 1 (1 429 521 B) | absent   | absent       | absent      | absent         |
| `apps/student-mobile/dist/metadata.json`                 | 1               | absent   | absent       | absent      | absent         |
| `apps/web/.next`                                         | 154             | absent   | absent       | absent      | absent         |
| `apps/control/.next`                                     | 154             | absent   | absent       | absent      | absent         |
| `apps/api/dist`                                          | 12              | absent   | absent       | absent      | absent         |
| `apps/worker/dist`                                       | 6               | absent   | absent       | absent      | absent         |

`braces` is a build-time input to producing the bundle, present in `node_modules` on developer/CI machines
only. It is not part of any shipped artifact.

### Available remediation

| Option                                       | Assessment                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upgrade to a patched `braces`                | **Not available.** Registry lists `3.0.3` as latest; advisory lists no patched version.                                                                                                                |
| Upgrade `micromatch`                         | **Not available.** `micromatch@4.0.8` is already the registry latest and pins `braces@^3.0.3`.                                                                                                         |
| Upgrade `metro-file-map`                     | **Not a fix.** Latest is `0.87.1`, which still depends on `micromatch` → `braces@^3.0.3`. Adopting it would also be a Metro major bump requiring Expo SDK alignment, and would not clear the advisory. |
| Upgrade `eslint-config-next` / Next.js       | **Not a fix.** The lint plugin path uses `fast-glob` → `micromatch` → `braces` regardless of Next.js version while that plugin keeps `fast-glob`.                                                      |
| Drop `eslint-config-next`                    | **Rejected.** Would remove real lint coverage for the two Next.js apps to eliminate a lint-tooling advisory. Not justified at Stage 0.                                                                 |
| Override `braces` to a fixed fork            | **Rejected.** Unverified third-party source. Not permitted and not done.                                                                                                                               |
| `pnpm patch` / patched-package source edit   | **Rejected.** Prohibited; would not survive a lockfile-only install.                                                                                                                                   |
| `pnpm audit` ignore / lower the CI threshold | **Rejected.** Explicitly prohibited; would produce a false green gate.                                                                                                                                 |

**Remediation attempts made during this task:** none were applied. Registry version listings were checked
(`npm view braces versions`, `npm view micromatch version`, `npm view metro-file-map version`), and the
consumer call sites were read in `get-root-dirs.js`, `metro-file-map/src/watchers/common.js`, and
`micromatch/index.js`. No lockfile, workspace, or CI change was made for this advisory.

### Compensating controls

- TSMS configures no glob patterns derived from user input anywhere, so there is no code path to harden
  today. This is a _design_ control, not an input filter.
- Metro is not configured by TSMS, so pattern sources remain upstream constants that change only with an
  explicit Expo/Metro upgrade.
- The ESLint `rootDir` values are repository literals reviewed in code review.
- `minimumReleaseAgeStrict` and `strictPeerDependencies` remain enabled, and the `allowBuilds` allowlist
  prevents arbitrary install scripts.
- The CI high-severity audit gate remains enabled and still fails, so this advisory cannot silently return.

### Current disposition

**OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY**

| Field                            | Value                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner decision                   | **ACCEPTED**                                                                                                                                                                   |
| Decided by                       | Project owner (TeamStack Technologies LTD)                                                                                                                                     |
| Decision date                    | 2026-10-07                                                                                                                                                                     |
| Decision basis                   | The existing reachability analysis recorded in this register: enumerated call sites, attacker-input analysis, deployment-artifact scans, and the rejected remediation options. |
| Reached state                    | OPEN - temporarily accepted with documented non-reachability                                                                                                                   |
| Remediated?                      | **No**                                                                                                                                                                         |
| Resolved?                        | **No**                                                                                                                                                                         |
| Package still installed          | **Yes** - `braces@3.0.3`                                                                                                                                                       |
| Vulnerable code still on disk    | **Yes** - unguarded recursive walkers in `lib/compile.js` and `lib/expand.js`                                                                                                  |
| Patched upstream release exists? | **No**                                                                                                                                                                         |
| Reconsideration                  | Mandatory if any review trigger in this entry occurs                                                                                                                           |

**This is not remediation and not resolution.** `braces@3.0.3` remains installed, the unguarded recursive
walkers are present on disk, and no patched upstream release exists. No suppressive measure was applied:
the advisory is not suppressed, the audit threshold is not lowered, no fork or patched package was
introduced, and `pnpm audit --audit-level=high` still exits non-zero and is still reported as FAIL.

The acceptance rests on the documented absence of any attacker-influenced brace pattern and the absence of
the package from all deployed runtime trees, not on an assumption that "transitive means safe". If any
review trigger below fires, or if the reachability analysis is ever shown to be wrong, this disposition
reverts to BLOCKING without any dependency change being required.

### Evidence

- `artifacts/stage0-risk/why-braces.json` - inherited `pnpm why` dependency tree
- `artifacts/stage0-risk/locations.json` - inherited on-disk package locations
- `pnpm why -r braces`, `pnpm why -r braces --json`
- `pnpm --filter @tsms/api list --prod --depth 30`, `pnpm --filter @tsms/worker list --prod --depth 30`, `pnpm --filter @tsms/web list --prod --depth 30`
- Direct source reads:
  `node_modules/.pnpm/@next+eslint-plugin-next@16_.../node_modules/@next/eslint-plugin-next/dist/utils/get-root-dirs.js`,
  `node_modules/.pnpm/metro-file-map@0.84.6_.../node_modules/metro-file-map/src/watchers/common.js`,
  `node_modules/.pnpm/metro-file-map@0.84.5_.../node_modules/metro-file-map/src/watchers/common.js`,
  `node_modules/.pnpm/micromatch@4.0.8/node_modules/micromatch/index.js`,
  `node_modules/.pnpm/braces@3.0.3/node_modules/braces/lib/{parse,compile,expand,constants}.js`
- `eslint.config.mjs:38-39` (static `rootDir` literals)
- Absence of any `metro.config.*` / `babel.config.*` in the repository
- Repository grep over `apps/**` for glob-engine usage
- Local stack-exhaustion probe reproduced under `node`, `node --stack-size=600`, `node --stack-size=200`

### Review triggers

Re-analyse this entry immediately if any of the following occurs:

1. `braces` publishes a release above `3.0.3`, or [micromatch/braces#70](https://github.com/micromatch/braces/issues/70)
   is closed in a tagged release.
2. `metro`, `metro-file-map`, `micromatch`, `fast-glob`, `metro` (Expo SDK), or `eslint-config-next` /
   `@next/eslint-plugin-next` is updated, or `expo`, `react-native`, or `next` is upgraded.
3. TSMS adds a `metro.config.*` that passes brace-bearing or otherwise dynamic patterns to `watchFolders`,
   `resolver.blockList`, `extraNodeModules`, `watcher.additionalExts`, or `resolver.sourceExts`.
4. TSMS adds any feature that accepts a user- or tenant-supplied glob, path pattern, ignore list, include
   list, file filter, export filter, or asset-matching expression, especially one passed to `micromatch`,
   `fast-glob`, `picomatch`, `braces`, `glob`, `anymatch`, `micromatch`-based ESLint overrides, or Next.js
   `outputFileTracingIncludes` / `outputFileTracingExcludes`.
5. A deployed TSMS service begins depending on a package that pulls `micromatch`/`braces` into a
   request-handling path.
6. `pnpm audit` stops reporting this advisory (verify removal versus configuration change before assuming
   a fix).

**Any of these triggers voids the 2026-10-07 owner acceptance above** and requires a fresh reachability
analysis plus a new owner decision. The disposition reverts to BLOCKING in the interim.

---

## Hosted re-confirmation of the two accepted dispositions - 2026-10-08

Stage 2.3 implementation commit `c75361e85e5315b8eb17646da2825cfd9eea7b91`, hosted run
[37733953331](https://github.com/ubaliringim/tsms/actions/runs/37733953331). The `security-audit` job failed,
as it always does, on exactly the two dispositions recorded above and nothing else:

| Advisory            | Package      | Severity | Vulnerable versions | Patched versions |
| ------------------- | ------------ | -------- | ------------------- | ---------------- |
| GHSA-86w9-cpqp-85rv | `node-forge` | high     | `<= 1.4.0`          | **None**         |
| GHSA-vfj7-8cjw-p6xm | `braces`     | high     | `<= 3.0.3`          | **None**         |

`2 vulnerabilities found / Severity: 2 high`. No new advisory, no suppression, no `ignoreCves`, no threshold
change, no reclassification, and no mark of resolution. The `validate` job passed in the same run, so the
workflow is red solely because of this accepted baseline, not because of a functional regression.

The reachability analyses in this register are unchanged by Stage 2.3: nothing added touches Expo, Metro,
Next.js linting, or any glob or RSA verification path. The review triggers below therefore have **not** fired.

Stage 2.3 was accepted and closed by the project owner on 2026-10-08. **Acceptance does not resolve either
disposition.** Both packages remain installed, both vulnerable code paths remain present on disk, neither
has an upstream patched release, and `pnpm audit --audit-level=high` still fails with `2 vulnerabilities
found / Severity: 2 high`. The overall workflow is still red. The raw audit result is not hidden, and no
new exception, suppression, ignore rule, threshold change, or expiry has been introduced.

## Cross-cutting review triggers

In addition to the per-advisory triggers above:

- Any change to `pnpm-workspace.yaml` `overrides`, `allowBuilds`, `minimumReleaseAgeExclude`, or to the CI
  audit threshold.
- Any change that moves a build tool into a deployed runtime dependency tree.
- Any Stage 1+ work that introduces cryptographic signature verification, certificate handling, or
  user-controlled pattern matching - the three conditions that would convert one or both of these
  OPEN entries into BLOCKING without any dependency change at all.
- Any appearance of a new high or critical advisory, which is unacceptable by default and requires its own
  review regardless of the existing acceptances.

## Change policy

Do not record a disposition change without re-running the reachability analysis and recording actual
command output. Do not mark an advisory RESOLVED while the package remains installed. Do not accept or
revoke a temporary disposition on behalf of the project owner.

Owner acceptances recorded here are dated, scoped by advisory ID, and valid only until a review trigger
fires. They are not blanket approvals of transitive tooling and are not precedent for accepting future
findings.
