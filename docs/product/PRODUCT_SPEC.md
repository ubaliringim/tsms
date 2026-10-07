# TSMS product specification

Status: accepted product direction; implementation is incremental.

## Identity and purpose

**TeamStack School Management System (TSMS)** is a commercial multi-tenant SaaS platform owned by **TeamStack Technologies LTD**, initially serving primary and secondary schools. Each school presents its own name, branding, and eventually managed subdomain/custom domain over one shared platform. Example hostnames in documentation are illustrative, not configured infrastructure.

TSMS helps students continue learning outside class and helps teachers understand learning gaps. The guiding question is **what should this student understand next?** Engagement serves learning; maximizing scrolling is not the goal. This is a production-oriented product developed in bounded stages, not a disposable prototype.

The core loop is school curriculum → approved resources → ingestion/understanding → concepts → learning objects → teacher review → publication → student learning → practice/assessment → mastery → adaptive revision → teacher insights.

## Experiences

| Experience | Users and purpose                                          | Areas                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student    | Students learn, practice, revise, and progress             | Personalized home, Continue Learning, goals, subjects, learning paths/feed, visual cards, questions/challenges, contextual AI help, practice, spaced revision, mastery, assignments, assessments, focus missions, and engagement rewards. |
| Teach      | Teachers create, teach, assess, understand, and intervene  | Classes, students, curriculum, Content Studio, assessments, assignments, weak concepts, misconceptions, prerequisite gaps, and progress.                                                                                                  |
| Admin      | Authorized school staff manage and understand their school | Students/teachers, academic structure, curriculum, learning analytics, reports, users, branding, settings, and subscription.                                                                                                              |
| Control    | Authorized TeamStack personnel operate the platform        | Onboarding, tenant configuration, subscriptions/plans, feature flags, storage/AI quotas, usage, health, support, audit, billing, and platform configuration.                                                                              |

Student UX is mobile-first, simple, visual, and age-appropriate; it must not feel like administrative software. Duolingo and Deepstash are engagement inspirations, not sources of copied UI, branding, or assets. Teacher UX emphasizes actions and intervention. Admin reporting supports School → Level → Class → Subject → Topic → Student; simplistic best/worst teacher rankings are excluded. Platform operations do not automatically grant access to children's private records.

## Academic and learning model

- School → academic session → terms → configurable levels → class groups → subjects → teacher assignments → enrollment history. Support terminology such as JSS 1 and Grade 7 without hard-coding a country's naming throughout the engine.
- Curriculum → unit → topic → concept. Relationships can be PREREQUISITE, RELATED_TO, or PART_OF. PostgreSQL can represent these initially.
- Reusable learning objects include CONCEPT, DEFINITION, EXAMPLE, IMAGE, DIAGRAM, VIDEO, FACT, QUESTION, CHALLENGE, SUMMARY, and REFLECTION. Do not collapse lessons into unstructured HTML blobs.
- Mastery belongs to student/concept pairs and reflects estimated learning state. Preserve evidence/history and algorithm versions. Initial algorithms may be simple and deterministic.
- XP represents engagement rewards, not mastery. Use an XP ledger when that stage is implemented. Potential rewards include streaks, levels, badges, missions, achievements, and configurable class challenges/leaderboards.
- Initial recommendations use curriculum priority, weakness, revision due, assignments, prerequisites, and assessment proximity. Successful recall can increase review intervals; failure can shorten them. Exact formulas require stage-specific specifications.

## Content and contextual AI

Resources include PDF, DOCX, PPTX, teacher notes, pasted text, images, approved web resources/video links, and manual content. Content Studio validates/processes resources, extracts structure/chunks/concepts, generates learning objects/questions, validates output, and sends it for teacher review before publication. Teachers need editing, review, and provenance, not automatic unreviewed publishing.

Contextual actions include Explain Simply, Give Me a Hint, Explain Visually, Give Another Example, Test Me, and Ask About This. TSMS supplies narrowly scoped curriculum/learning context instead of exposing children to an unrestricted generic chatbot or sending unnecessary personal data.

## Product boundaries

- Personal-device Focus Mode must respect OS permissions/limitations; universal blocking of other apps is not promised. Managed-device/kiosk functionality is a later option.
- Approved external video links and appropriate hosted assets are enough initially; dedicated transcoding is deferred.
- Parents/guardians, advanced adaptive models, deeper offline sync, predictive analytics, and richer gamification can follow. They are not Stage 0 deliverables.
- Fees, payroll, transport, and unrelated ERP modules are not implied by the product name.
- Commercial pricing, launch cohorts, success thresholds, legal review, and exact release scope remain open product decisions. Do not invent them.

## Success direction

Students return for useful learning; teachers save preparation time and find gaps earlier; schools see curriculum progress; TeamStack can add schools without separate backend codebases. These are intended outcomes, not measured claims.
