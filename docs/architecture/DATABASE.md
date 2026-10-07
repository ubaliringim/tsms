# Database and domain model direction

Status: conceptual design. **No Prisma business schema or migrations in Stage 0.**

## Sources of truth

PostgreSQL owns structured business truth. Object storage owns files. Learning events are activity evidence; mastery and analytics are derived state; embeddings are retrieval indexes. AI output never becomes authoritative identity, billing, security, or curriculum approval state by itself.

## Domain groups to introduce incrementally

| Area                 | Eventual records                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/tenancy     | users, tenants, schools, memberships, roles, permissions, membership_roles, role_permissions, student_profiles, teacher_profiles      |
| Academics            | academic_sessions, academic_terms, academic_levels, class_groups, student_enrollments, subjects, class_subjects, teacher_assignments  |
| Curriculum           | curricula, curriculum_units, topics, concepts, concept_relationships                                                                  |
| Resources/content    | resources, resource_chunks, resource_concepts, learning_objects, learning_object_sources, ai_generations, content_reviews             |
| Assessment           | questions, question_options, assessments, assessment_questions, assessment_attempts, assessment_answers                               |
| Learning             | learning_sessions, learning_session_items, practice_attempts, student_concept_mastery, mastery_updates, assignments                   |
| Engagement/reporting | xp_transactions, student_streaks, achievement_definitions, student_achievements, learning_events, analytics aggregates, notifications |
| Operations           | tenant_branding, tenant_domains, tenant_features, plans, subscriptions, usage counters, audit_logs                                    |

## Invariants

- Separate global identity from tenant membership; student/teacher profiles attach to membership context.
- School-owned records have tenant scope. Uniqueness for school-owned codes is tenant-aware, e.g. `(tenant_id, student_number)`.
- Foreign-key relationships must not connect School A records to School B records. Use appropriate constraints and isolation tests, not only independent ID existence checks.
- Enrollment records preserve academic history; do not overwrite a student's class every year.
- Curriculum hierarchy is curriculum → unit → topic → concept. Concept relationships represent prerequisites/related/part-of links without a graph database initially.
- Learning objects are structured, extensible, versioned, and linked to sources/reviews.
- Content workflow includes DRAFT, GENERATING, GENERATED, IN_REVIEW, CHANGES_REQUESTED, APPROVED, PUBLISHED, and ARCHIVED; stage-specific transitions and permissions remain to be designed.
- Mastery is scoped by student/concept/tenant, with score, confidence, attempt/success counts, practice/success/review timestamps, algorithm version, and explanatory evidence/history.
- Assessment answers and practice attempts are evidence, not only final aggregate marks.
- XP uses a transaction ledger; retry/idempotency rules must prevent duplicate rewards.
- Use deliberate retention/archive/deletion policies. Do not add soft deletion everywhere without understanding privacy and academic-history needs.
- Never store large uploaded binaries in PostgreSQL. Index actual access paths and introduce vector indexes based on corpus/query requirements.

## Migration strategy

Stage 1 establishes local infrastructure and migration tooling. Identity/tenancy/academic/curriculum schemas then arrive with their respective approved tasks and tests. Do not materialize the entire conceptual table list at once. RLS is an investigation requiring connection/session/Prisma compatibility analysis before adoption.
