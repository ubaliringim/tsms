# Multi-tenancy and isolation

Accepted initial strategy: shared PostgreSQL database, shared schema, explicitly scoped school-owned records.

## Trusted context

Authenticate user → verify membership → resolve requested domain/context → authorize tenant → authorize action/resource. A domain or client-provided tenant ID can help select context but never grants access. Global identity is separate from membership, allowing one person to participate in multiple schools.

Never query tenant-owned data without trusted context. Tenant-aware repositories should make missing scope difficult; explicit cross-tenant operations require a distinct privileged pathway. Roles are permission sets, supplemented by tenant, class, subject, assignment, ownership, and resource-state checks.

## Boundaries beyond SQL

Apply tenant/publication/permission constraints to files, signed URLs, cache keys, queue messages, exports, analytics, and AI retrieval. Semantic similarity must never retrieve another school's content. Filter during retrieval, not after an answer is generated.

Use tenant-aware uniqueness and foreign keys/constraints to prevent cross-tenant relationships. Consider RLS only after evaluating actual Prisma/connection pooling/session behavior; application authorization remains necessary.

## Platform and school access

TeamStack operational access does not imply unrestricted student-data access. Future support access must be justified, scoped, time-limited where possible, and audited. Branding/custom domains affect presentation, not authorization.

## Required future verification

Build fixtures for Schools A and B. Test reads, writes, forged IDs, membership switching, object references, files, background processing, caches, and semantic retrieval. Permission failures must not leak existence/content. Add appropriate regression tests as those capabilities arrive. Stage 0 has no tenant data or claims of implemented tenant isolation.
