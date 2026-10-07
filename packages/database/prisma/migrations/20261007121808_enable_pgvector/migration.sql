-- Establish pgvector availability as an infrastructure capability.
--
-- Stage 1 creates NO vector columns, embeddings, indexes, or retrieval logic.
-- This migration only makes the extension present so that a later, separately
-- approved stage can add vector support without changing the database image or
-- re-planning the foundation.
--
-- The role that applies migrations must be permitted to CREATE EXTENSION. In
-- local Docker Compose the `tsms` role is a superuser. In staging and production
-- the migration role needs the privilege, or a DBA must run this statement
-- before `prisma migrate deploy` is used for the first time.

CREATE EXTENSION IF NOT EXISTS vector;