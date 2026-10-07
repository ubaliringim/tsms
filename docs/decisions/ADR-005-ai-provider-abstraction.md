# ADR-005: Provider-Neutral AI Layer

Status: Accepted

Date: 2026-10-07

## Context

Cost, availability, quality, and capabilities vary across models/providers.

## Decision

Keep domain logic independent of vendors through application-owned generation, structured-output, embedding, and moderation capabilities as needed.

## Consequences

Introduce concrete interfaces/adapters when a feature consumes them; do not add dummy providers now. Security and accounting remain deterministic.

## Change policy

Do not silently violate this decision. Propose a superseding ADR if evidence requires a change.
