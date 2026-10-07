# ADR-006: Event-Driven Learning State Updates

Status: Accepted

Date: 2026-10-07

## Context

One learning action may affect mastery, rewards, analytics, recommendations, and notifications.

## Decision

Represent learning activity as structured events and update derived state through explicit consumers using the application/job architecture initially.

## Consequences

Define durable delivery and idempotency when persistence/queues arrive. Avoid duplicate XP/mastery effects on retries. Kafka is not part of the initial foundation.

## Change policy

Do not silently violate this decision. Propose a superseding ADR if evidence requires a change.
