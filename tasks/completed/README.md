# Accepted tasks

Place task records here after review/acceptance. A stage is not accepted merely because checks pass. Keep active
validation and handoff in tasks/CURRENT.md until reviewed.

| Task                                                                                             | Stage                               | Status   | Accepted   | Record                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------- | -------- | ---------- | -------------------------------------------------------------- |
| [0.1 Repository and engineering foundation](stage-0-engineering-foundation.md)                   | 0 - Engineering Foundation          | ACCEPTED | 2026-10-07 | `tasks/completed/stage-0-engineering-foundation.md`            |
| [1.1 Database and local infrastructure foundation](stage-1-database-and-local-infrastructure.md) | 1 - Database & Local Infrastructure | ACCEPTED | 2026-10-07 | `tasks/completed/stage-1-database-and-local-infrastructure.md` |
| [1.2 Hosted CI repair](stage-1-hosted-ci-repair.md)                                              | 1 - Database & Local Infrastructure | ACCEPTED | 2026-10-07 | `tasks/completed/stage-1-hosted-ci-repair.md`                  |
| [2.1 Authentication identity schema](stage-2-1-identity.md)                                      | 2 - Authentication & Identity       | ACCEPTED | 2026-10-08 | `tasks/completed/stage-2-1-identity.md`                        |
| [2.2 Password credential service](stage-2-2-password-credentials.md)                             | 2 - Authentication & Identity       | ACCEPTED | 2026-10-08 | `tasks/completed/stage-2-2-password-credentials.md`            |

Stage 2.1 and Stage 2.2 are accepted substages of Stage 2. **Stage 2 as a whole is not accepted.** Stage 2.3
(Secure Session Foundation) is locally validated and awaiting owner review; Stage 2.4 and later are not started
and not authorized. The active task record is `tasks/CURRENT.md`.

Accepting a stage does **not** resolve anything in the dependency risk register. Both accepted advisories
(node-forge and braces) remain installed and unresolved under their owner-approved temporary dispositions, and
`pnpm audit --audit-level=high` remains failing. See `docs/security/DEPENDENCY_RISK_REGISTER.md`.

Each accepted record preserves its own implementation summary, architectural decisions, validation evidence,
security findings, known issues, and acceptance date.
