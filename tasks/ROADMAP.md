# TSMS engineering roadmap

These are controlled milestones, not promises of separate deployments. Each stage needs bounded tasks and explicit acceptance criteria before implementation. Stage 0 (Engineering Foundation) was accepted on 2026-10-07. Stage 1 (Database & Local Infrastructure) was accepted on 2026-10-07. Stage 2 (Authentication & Identity) Specification v1.0 is owner approved. Stages 2.1 through 2.8 are ACCEPTED / HOSTED VERIFIED / CLOSED, Stage 2.6 on implementation commit `ca66284` and hosted run [38123962717](https://github.com/ubaliringim/tsms/actions/runs/38123962717), Stage 2.7 (Security Events & Sanitization) on implementation commit `d898ae9` and hosted run [38231523798](https://github.com/ubaliringim/tsms/actions/runs/38231523798) (`validate` success; `security-audit` expected failure; workflow RED), and Stage 2.8 (Minimal Web Authentication Integration) on implementation commit `6ba9086` and hosted run [38258942541](https://github.com/ubaliringim/tsms/actions/runs/38258942541) (`validate` success; `security-audit` expected failure; workflow RED; browser tests are local-only and not in hosted CI). Stage 2 overall is not accepted. Stage 2.9 (security review and controlled remediation) is REMEDIATION IMPLEMENTED / LOCALLY VALIDATED EXCEPT ONE EXTERNAL FAILURE / UNDER OWNER REVIEW (uncommitted, not hosted-verified, not accepted). Stage 2.10 and later work are NOT STARTED / UNAUTHORIZED. Production deployment is not authorized.

| Stage | Scope                             |
| ----- | --------------------------------- |
| 0     | Engineering Foundation            |
| 1     | Database & Local Infrastructure   |
| 2     | Authentication & Identity         |
| 3     | Multi-Tenancy                     |
| 4     | RBAC & Authorization              |
| 5     | School Onboarding & Branding      |
| 6     | Academic Structure                |
| 7     | Students, Teachers & Enrollment   |
| 8     | Curriculum Engine                 |
| 9     | Resources & Document Processing   |
| 10    | Content Studio                    |
| 11    | Student Learning Core             |
| 12    | Assessment Engine                 |
| 13    | Mastery Engine                    |
| 14    | Recommendations & Spaced Revision |
| 15    | AI Tutor & RAG                    |
| 16    | Gamification                      |
| 17    | Teacher Intelligence              |
| 18    | School Analytics                  |
| 19    | TSMS Control                      |
| 20    | Production Hardening              |

## Stage gates and dependencies

Stage 0 was reviewed and accepted by the owner before Stage 1 started; that gate is now closed. Stage 1 was reviewed and accepted before Stage 2 starts; that gate is now closed too. Substage gates 2.1 through 2.6 are likewise closed. Security and tenant-aware design apply throughout, not only in Stage 20. Identity must accommodate membership before later tenancy/RBAC milestones. Content generation needs provider boundaries and teacher approval in Stages 9-10, before the dedicated tutoring milestone. Stage 20 consolidates production controls, recovery, operational readiness, and launch validation.

Acceptance of a stage is not production readiness. Stage 2.6 closed with its limitations still open, including lease-expiry over-admission, Redis as a hard dependency for login and recovery, an unapproved proxy-trust model that blocks production use behind a shared TLS-terminating proxy, HMAC secret provisioning and rotation, provisional thresholds, and untested Redis Cluster. Both accepted dependency advisories (`node-forge` `GHSA-86w9-cpqp-85rv`, `braces` `GHSA-vfj7-8cjw-p6xm`) remain open and unsuppressed, so the CI workflow continues to report red.

Future stages require their own task breakdown, schemas/contracts, permission rules, validation commands, and handoff. Do not infer implementation authorization from this roadmap.
