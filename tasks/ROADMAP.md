# TSMS engineering roadmap

These are controlled milestones, not promises of separate deployments. Each stage needs bounded tasks and explicit acceptance criteria before implementation. Stage 0 (Engineering Foundation) was accepted on 2026-10-07. Stage 1 (Database & Local Infrastructure) is the next planned stage, but implementation authorization has NOT been granted and no Stage 1 task is active.

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

Stage 0 was reviewed and accepted by the owner before Stage 1 starts; that gate is now closed. Security and tenant-aware design apply throughout, not only in Stage 20. Identity must accommodate membership before later tenancy/RBAC milestones. Content generation needs provider boundaries and teacher approval in Stages 9-10, before the dedicated tutoring milestone. Stage 20 consolidates production controls, recovery, operational readiness, and launch validation.

Future stages require their own task breakdown, schemas/contracts, permission rules, validation commands, and handoff. Do not infer implementation authorization from this roadmap.
