# Changelog

## Unreleased - Stage 0

- Organized TSMS specifications, seven accepted ADRs, roadmap, and agent handoff protocol.
- Established a pnpm/Turborepo TypeScript workspace and five minimal application foundations.
- Added shared server configuration, process-liveness checks, meaningful foundation tests, and validation/CI baseline.
- Completed reachability analysis for two open high-severity dependency advisories and recorded them in `docs/security/DEPENDENCY_RISK_REGISTER.md`.
- Owner accepted temporary dispositions for `node-forge` (GHSA-86w9-cpqp-85rv) and `braces` (GHSA-vfj7-8cjw-p6xm) on documented non-reachability. Both remain installed and unresolved; no advisory was suppressed and the audit gate still fails.
- Stage 0 accepted by the owner on 2026-10-07.
- No product features, data services, or production deployment.
