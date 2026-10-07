# ADR-002: Shared-Schema Multi-Tenancy

Status: Accepted

Date: 2026-10-07

## Context

Schools share one platform while their private data must remain isolated.

## Decision

Use a shared PostgreSQL database/schema with explicit tenant-scoped school records. Derive authorized context from identity and membership; do not trust client tenant IDs.

## Consequences

Tenant scoping applies to queries, relationships, jobs, caches, files, exports, and retrieval. Add isolation regression tests with each capability. RLS requires a separate evaluated decision.

## Change policy

Do not silently violate this decision. Propose a superseding ADR if evidence requires a change.
