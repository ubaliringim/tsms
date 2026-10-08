# TSMS engineering roadmap

These are controlled milestones, not promises of separate deployments. Each stage needs bounded tasks and explicit acceptance criteria before implementation. Stage 0 (Engineering Foundation) was accepted on 2026-10-07. Stage 1 (Database & Local Infrastructure) was accepted on 2026-10-07. Stage 2 (Authentication & Identity) Specification v1.0 is owner approved. Stage 2.1 is ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2 is ACCEPTED / HOSTED VERIFIED / CLOSED. Implementation is authorized ONLY for Stage 2.3 (Secure Session Foundation). Stage 2 overall is not accepted. Stage 2.4 and later work are NOT STARTED / UNAUTHORIZED.

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

Stage 0 was reviewed and accepted by the owner before Stage 1 started; that gate is now closed. Stage 1 was reviewed and accepted before Stage 2 starts; that gate is now closed too. Security and tenant-aware design apply throughout, not only in Stage 20. Identity must accommodate membership before later tenancy/RBAC milestones. Content generation needs provider boundaries and teacher approval in Stages 9-10, before the dedicated tutoring milestone. Stage 20 consolidates production controls, recovery, operational readiness, and launch validation.

Future stages require their own task breakdown, schemas/contracts, permission rules, validation commands, and handoff. Do not infer implementation authorization from this roadmap.
