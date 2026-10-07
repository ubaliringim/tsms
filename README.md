# TSMS - TeamStack School Management System

Owned by **TeamStack Technologies LTD**. A multi-tenant learning and school-management platform for primary and secondary schools, developed in reviewed engineering stages.

**Current scope: Stage 0 engineering foundation only; status PARTIAL.** The core checks pass, but two upstream high-severity dependency advisories keep the audit gate failing; see [dependency review](docs/architecture/DEPENDENCY_REVIEW.md). No authentication, database, tenant business logic, learning features, AI integration, or production deployment exists. Read [PROJECT_STATE.md](PROJECT_STATE.md) and [tasks/CURRENT.md](tasks/CURRENT.md) for current validation/handoff. Coding agents must begin with [AGENTS.md](AGENTS.md).

## Requirements and installation

Use Node **24.16.0** (also in `.node-version`/`.nvmrc`) and pnpm **12.3.4**. The package manager is pinned in package.json; no global CLI upgrades are required by this project. Install that pnpm version if it is not available. Use `pnpm.cmd` in Windows PowerShell if execution policy blocks the `.ps1` shim.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm mobile:check
pnpm mobile:export
pnpm smoke
```

The lockfile is authoritative. Install scripts are explicitly allowed for required tooling in pnpm-workspace.yaml; the Nest donation script is disabled. Exact release-age exceptions for the selected Next/Expo versions are recorded; strict release-age mode prevents silent expansion on future updates. Review dependency/configuration changes instead of bypassing peer checks. No database, Redis, S3, AI account, or credentials are needed for Stage 0.

## Applications

| Workspace            | Development command                      | Default address              |
| -------------------- | ---------------------------------------- | ---------------------------- |
| @tsms/web            | `pnpm --filter @tsms/web dev`            | http://127.0.0.1:3000        |
| @tsms/control        | `pnpm --filter @tsms/control dev`        | http://127.0.0.1:3001        |
| @tsms/api            | `pnpm --filter @tsms/api dev`            | http://127.0.0.1:4000/health |
| @tsms/worker         | `pnpm --filter @tsms/worker dev`         | http://127.0.0.1:4001/health |
| @tsms/student-mobile | `pnpm --filter @tsms/student-mobile dev` | Expo development server      |

Before running an individual API/worker dev command, run `pnpm --filter @tsms/config build`. `pnpm dev` builds shared dependencies and runs all development processes through Turbo; individual commands are often more convenient. API/worker `start` runs compiled output after `pnpm build`. Web/Control `start` runs their production Next.js builds. The worker currently only exposes process liveness; no queue is connected.

Mobile uses Expo SDK 57 with its matched React/React Native versions. `mobile:check` checks SDK dependency compatibility; `mobile:export` verifies Android JS bundling. Native device/emulator and store-signed builds are separate validation and are not implied by these checks. There is intentionally no mobile `build` script in the root build graph.

## Environment strategy

Defaults allow local startup without a `.env`. Optionally copy the root `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`). API/worker scripts load the root file using Node's `--env-file-if-exists`. Existing process environment takes precedence. Turbo forwards the explicitly named server variables in turbo.json.

`@tsms/config` uses Zod to validate NODE_ENV, bind host, and ports before listening. Ports must be integers in 1-65535; invalid configuration exits with a nonzero code and reports keys, not values. Unrelated environment keys are discarded from parsed config. This is server-only code; never import it into client bundles.

Web/mobile have no application environment variables yet. Add validated variables when consumed by real features. NEXT_PUBLIC_ and EXPO_PUBLIC_ values are public, never a place for secrets. Future connection strings/provider credentials are deliberately absent from Stage 0 examples.

## Validation

- `pnpm format:check` / `pnpm format`: Prettier check/format.
- `pnpm lint`: repository ESLint including Next.js rules.
- `pnpm typecheck`: all applications and shared configuration, including Expo static typing.
- `pnpm test`: meaningful environment and API/worker HTTP tests; builds tested code first.
- `pnpm build`: shared config, API, worker, web, Control. No native mobile binary build.
- `pnpm check`: formatting, lint, typecheck, tests, builds in order.
- `pnpm smoke`: compiled startup, invalid environment failure, HTTP liveness, and production web/Control routes; starts and cleans up its own processes on temporary local ports.
- `pnpm audit --audit-level=high`: dependency vulnerability review.

CI mirrors these gates on Linux. Local Windows checks are recorded in the handoff; a workflow file alone does not prove hosted CI ran. Health endpoints expose process liveness only and reveal no student data or dependency credentials.

## Repository map

`apps/` contains five application shells. `packages/config/` contains actual shared configuration; other target domain packages are [deferred](packages/README.md). `docs/` contains the product/architecture specifications and seven ADRs. `tasks/` owns roadmap/current work and later accepted task history. `scripts/` contains reproducible smoke verification. `tests/` describes the test strategy. `infrastructure/` documents the future service boundary without fake provisioning.

## Reading order and stage boundary

[Product](docs/product/PRODUCT_SPEC.md) - [architecture](docs/architecture/ARCHITECTURE.md) - [database](docs/architecture/DATABASE.md) - [multi-tenancy](docs/architecture/MULTI_TENANCY.md) - [security](docs/architecture/SECURITY.md) - [AI](docs/architecture/AI_ARCHITECTURE.md) - [ADRs](docs/decisions/) - [roadmap](tasks/ROADMAP.md).

Stage 0 requires review and acceptance before Stage 1. Do not implement product functionality or deploy from this task. Historical PROJECT_NOTES.md is preserved, but current specifications and task/state files govern future work.
