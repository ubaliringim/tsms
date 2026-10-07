# ADR-001: Modular Monolith First

Status: Accepted

Date: 2026-10-07

## Context

TSMS needs clear domains and independent background processing without premature distributed-system complexity.

## Decision

Use a NestJS modular monolith API and separately runnable workers. Keep module interfaces explicit.

## Consequences

Do not start with many microservices. Extract a service only when a demonstrated scaling or ownership need justifies it.

## Change policy

Do not silently violate this decision. Propose a superseding ADR if evidence requires a change.
