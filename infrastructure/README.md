# Local infrastructure

Development-only PostgreSQL and Redis for TSMS, defined in `docker-compose.yml`.

**Everything in this directory is for local development.** The credentials committed here are throwaway local
values that never leave a developer machine. Never reuse them in staging or production, and never point a staging
or production client at these hosts.

## Prerequisites

- Node 24.16.0 and pnpm 12.3.4 (see `.node-version` / `.nvmrc`).
- Docker with the Compose plugin. Verified with Docker 29.6.1 and Compose v5.3.0.
- Ports **5432** (PostgreSQL) and **6379** (Redis) free on `127.0.0.1`. Both are published on loopback only.
- A repository `.env`. Copy `.env.example` to `.env`; every value there already matches this compose file.

## Start

```bash
pnpm install
pnpm infra:up
```

`pnpm infra:up` waits for both services to report healthy before returning. Equivalent explicit command:

```bash
docker compose -f infrastructure/docker-compose.yml up -d --wait
```

First run pulls `pgvector/pgvector:0.8.7-pg17` and `redis:8.8.3-alpine`.

Services created:

| Container       | Image                          | Role                                 |
| --------------- | ------------------------------ | ------------------------------------ |
| `tsms-postgres` | `pgvector/pgvector:0.8.7-pg17` | PostgreSQL 17.11 with pgvector 0.8.7 |
| `tsms-redis`    | `redis:8.8.3-alpine`           | Redis 8.8.3, dev-only `requirepass`  |

One database is created up front: `tsms`, for the application. The `tsms_test` database used by integration
tests is created on demand, because `prisma migrate deploy` creates its target database when it does not exist.
`pnpm test:integration` applies migrations to it before running, so nothing else has to provision it.

## Status

```bash
docker compose -f infrastructure/docker-compose.yml ps
```

Health is enforced by container healthchecks (`pg_isready`, authenticated `redis-cli ping`), not by guessing.

## Logs

```bash
docker compose -f infrastructure/docker-compose.yml logs -f postgres
docker compose -f infrastructure/docker-compose.yml logs -f redis
```

## Stop

```bash
pnpm infra:down          # docker compose ... down
```

Stops and removes containers and the network. **Named volumes are preserved, so your data survives.**

`docker compose ... stop` only pauses containers; `pnpm infra:up` then resumes them with data intact.

## Reset

Both commands are **local-development-only and destructive**.

```bash
pnpm infra:reset        # docker compose ... down -v   -> deletes the named volumes, all database and Redis data
pnpm db:reset           # prisma migrate reset --force -> drops and recreates the tsms schema, keeps the database
```

Use `pnpm db:reset` when you only need a clean schema. Use `pnpm infra:reset` when you need to rebuild everything
from scratch, for example after changing a Postgres image. After `pnpm infra:reset`, run `pnpm infra:up` again;
`pnpm test:integration` then recreates and re-migrates `tsms_test` automatically.

Never point either reset command at staging or production.

## Migrations

Regenerate the Prisma client after any schema change:

```bash
pnpm db:generate
```

Local development (detects drift, uses a shadow database):

```bash
pnpm db:migrate
```

Check migration state:

```bash
pnpm db:status
```

**Staging and production use `migrate deploy` only.** It applies committed, reviewed SQL, never invents a
migration, and never resets data:

```bash
pnpm db:deploy
```

Applying migrations to the disposable test database, which integration tests depend on:

```bash
pnpm db:test:migrate
```

That command refuses to run unless the target database name ends in `_test` and the host is loopback, so it cannot
destroy the development database.

Prisma Studio (optional):

```bash
pnpm --filter @tsms/database db:studio
```

## Integration tests

```bash
pnpm infra:up             # services must be running
pnpm test:integration     # applies test migrations, then runs database and Redis suites
```

Ordinary unit tests do **not** need Docker:

```bash
pnpm test
```

## Application checks

```bash
pnpm smoke                # exercises /health and /ready against the compiled API and worker
```

`/health` returns 200 whenever the process is serving. `/ready` returns 503 when PostgreSQL or Redis is
unreachable, and reports only which dependency is down.

## Troubleshooting

**`docker compose up` fails with a port already in use.**
Another PostgreSQL or Redis is bound to 5432 or 6379. Stop it, or change the published host port in
`docker-compose.yml` and update `DATABASE_URL` / `REDIS_URL` / `TEST_DATABASE_URL` / `TEST_REDIS_URL` in `.env`
to match. Keep them consistent.

**`pnpm test:integration` reports `ECONNREFUSED`.**
The services are not running, or `.env` points somewhere else. Run `pnpm infra:up` and confirm with
`docker compose -f infrastructure/docker-compose.yml ps` that both containers are healthy.

**`prisma migrate dev` asks for a shadow database and fails.**
The `tsms` role in the compose file is a superuser and can create one. If you changed it, grant `CREATEDB`.

**Integration tests refuse to start with "Refusing to run …".**
The safety guard rejected the target. Check that `TEST_DATABASE_URL` names a database ending in `_test` and that
`TEST_REDIS_URL` selects a non-zero logical database. This is intentional and must not be bypassed by pointing the
tests at the application database.

**`pnpm db:generate` fails after a fresh install.**
Prisma downloads its engine binaries through an install script. Confirm `pnpm-workspace.yaml` still allows builds
for `@prisma/engines`.

**Resetting after changing image versions.**
`pnpm infra:reset` then `pnpm infra:up`. Postgres data directories are not portable across major versions, and a
new image tag will not start against an old data directory.

## Not provisioned here

Deliberately out of scope at Stage 1, with reasoning recorded in `docs/architecture/DATABASE.md`: BullMQ queues,
Redis caching or rate limiting, S3-compatible object storage, a production connection pooler, and cloud resources.
