# ADR-0011: Optional PostgreSQL backend, one repository layer on Kysely

- **Status:** Proposed
- **Date:** 2026-10-15
- **Deciders:** Project maintainer (direction chosen on 2026-10-15: "SQLite stays the default,
  PostgreSQL becomes a second backend tested with testcontainers"); implementation approach
  proposed by Claude Code, pending maintainer review
- **Related:** [SPEC-117](../specs/2026-10-15-postgresql-backend.md),
  [SPEC-006](../specs/2026-10-14-database-schema.md),
  [SPEC-004](../specs/2026-10-14-technology-stack.md),
  [SPEC-012](../specs/2026-10-14-testing-strategy.md),
  [ADR-0001](0001-local-first-architecture.md), [ADR-0002](0002-sqlite-with-node-sqlite.md),
  [ADR-0009](0009-self-hosted-readiness.md)

## Context

The maintainer wants a PostgreSQL backend now, tested in CI against a real PostgreSQL started by
testcontainers, while `npx directivebench` keeps working with zero setup on SQLite
([ADR-0001](0001-local-first-architecture.md)). Options considered with the maintainer on
2026-10-15: PostgreSQL only through Docker (Docker becomes a hard requirement), PostgreSQL only
through PGlite (WASM, single-process; web and runner are two processes), or a second backend.
The maintainer chose the second backend.

[ADR-0002](0002-sqlite-with-node-sqlite.md) anticipated this ("a PostgreSQL implementation behind
the same repository functions"). The repository layer is already portable (SPEC-006 §6): no
SQLite-only SQL, text IDs and timestamps, JSON as text, conditional updates instead of
single-writer assumptions. What blocks a second backend is the ORM: Drizzle schemas, column
mappers and query builders are dialect-specific (`sqliteTable` vs `pgTable`). With Drizzle,
supporting both dialects means two schemas **and** two repository implementations, because
query code typed against one dialect cannot be called with the other. Drizzle 1.0 does not
change that and is still pre-release.

A spike on 2026-10-15 ran the same Kysely code (schema builder DDL, insert, the job-acquisition
`UPDATE … WHERE id = (subquery) … RETURNING`, `count(*)`, transaction rollback,
`ON CONFLICT DO NOTHING`) against `node:sqlite` (through a 20-line adapter) and against
PostgreSQL 17 started by `@testcontainers/postgresql`. Both produced the same results except for
driver value types: SQLite returns booleans as `0/1` and `count(*)` as a number; PostgreSQL
returns `boolean` and `count(*)` as a string. Container start-up took about 5 s.

## Decision

1. **Two backends, one default.** SQLite (`node:sqlite`) stays the default and needs no
   configuration. PostgreSQL is used when `DIRECTIVEBENCH_DATABASE_URL` is set to a
   `postgres://` or `postgresql://` URL. The data directory is still used for files (config,
   fixtures, logs, workspaces) with either backend.
2. **Kysely replaces Drizzle** as the query builder and migration runner in
   `packages/database`. One typed database interface, one set of repository functions and one
   set of migrations serve both dialects:
   - SQLite through a `NodeSqliteDialect` (subclass of Kysely's `SqliteDialect`): an adapter over
     `DatabaseSync`, a driver whose transactions start with `begin immediate` (keeps the current
     write-lock behaviour) and an adapter that declares transactional DDL so migrations run in a
     transaction.
   - PostgreSQL through Kysely's `PostgresDialect` with `pg` (node-postgres, pure JavaScript).
   - `CamelCasePlugin` keeps the exported record shapes (`createdAt`, …) unchanged for callers.
3. **Portable storage types in both dialects.** Booleans are `integer` 0/1 and JSON is `text`
   in both, mapped by explicit per-table row mappers in the repository layer (no automatic JSON
   parsing plugin); fractional scores use `double precision` on PostgreSQL and `real` on SQLite
   (both 64-bit floats); sizes that can exceed 2 GiB use `bigint`; every PostgreSQL text column
   uses `COLLATE "C"` so ordering matches SQLite's binary collation. The PostgreSQL pool parses
   `int8` (counts, `bigint`) as numbers.
4. **Migrations are TypeScript modules** using Kysely's schema builder with literal snake_case
   names, imported statically (so tsup and Next.js bundle them) and applied with Kysely's
   `Migrator`; all pending migrations run in one transaction on both backends. The first
   migration reproduces the current SQLite schema exactly (a test compares it with a database
   created from the old Drizzle SQL). It also adopts existing SQLite databases: when
   `__drizzle_migrations` contains exactly the initial Drizzle migration, the migration creates
   nothing and is recorded normally; any other Drizzle history is refused. `__drizzle_migrations`
   is kept, so an older CLI can still open an adopted database while the schema is unchanged.
5. **Tests run every repository test against both backends** (Vitest projects `sqlite` and
   `postgresql` over the same files). PostgreSQL comes from `DIRECTIVEBENCH_TEST_POSTGRES_URL`
   when set, otherwise from `@testcontainers/postgresql` (one container per package test run,
   one database per test cloned from a migrated template). The 100% coverage gate applies to the
   PostgreSQL code paths as well, so `pnpm test` needs Docker or a PostgreSQL URL; without either
   it fails with an explicit message. All dialect-specific code stays inside
   `packages/database`.
6. **Transactions keep SQLite's guarantees on PostgreSQL.** `withTransaction` takes a
   transaction-scoped advisory lock (`pg_advisory_xact_lock`) on PostgreSQL, so check-then-act
   imports stay serialised like SQLite's single writer. Job acquisition stays a single
   conditional `UPDATE`; its `status = 'pending'` predicate is what prevents double claims under
   READ COMMITTED.
7. **The connection URL is a secret.** It is read only from the environment (never written to
   `config.json`, never accepted as a CLI flag, which would expose it in the process list),
   passed to the web child process through the inherited environment, and shown redacted
   (`postgres://user:***@host/db`, password query parameters masked) by `doctor` and in logs.
   The pool has a named connect timeout and an `error` listener so an unreachable or restarted
   server never hangs or crashes the process.
8. **Packaging.** `kysely` is bundled into the CLI; `pg` stays a runtime dependency of the
   published CLI (Next.js keeps it external), so the CLI's runtime dependencies become `next`,
   `react`, `react-dom` and `pg` (SPEC-004 §4).

## Alternatives considered

- **Drizzle with two schemas and two repository implementations.** Keeps the current library,
  but doubles the schema and every repository function (about 1,100 lines today); every future
  change is written twice and kept in step only by tests. Rejected as the larger long-term cost.
- **Drizzle with one schema object reused for PostgreSQL** (casting the PostgreSQL database to
  the SQLite type). Compiles, but Drizzle's SQLite column mappers misread PostgreSQL values
  (e.g. booleans) and SQLite-only builder methods (`.get()`) fail at run time. Rejected: the type
  system would lie.
- **Raw SQL with our own thin mapper.** Loses typed queries; rejected.
- **PostgreSQL only (Docker or PGlite).** Discussed with the maintainer; rejected in favour of a
  second backend (Docker would become mandatory; PGlite does not fit two processes sharing one
  database, see ADR-0002).
- **Prisma / TypeORM / MikroORM.** Heavier runtime, code generation or native engines; conflict
  with the zero-install `npx` distribution (SPEC-004 §4).

## Benefits

- One repository implementation and one migration history for both backends.
- Kysely is MIT-licensed, has no dependencies and no native code; `pg` is pure JavaScript.
- A real PostgreSQL in CI catches dialect differences the SQLite tests cannot.
- The persistence boundary required by ADR-0009 now has a second implementation, so
  self-hosting work starts from a tested PostgreSQL path.

## Drawbacks

- The repository layer is rewritten from Drizzle to Kysely (behaviour pinned by the existing
  repository tests at 100% coverage), including explicit row mappers for JSON and boolean columns
  and aliasing in multi-table joins.
- Kysely has no declarative schema diffing: migrations are written by hand (drizzle-kit
  generated them). Reviews must check that a migration and the `Database` interface agree; a test
  compares the migrated schema of both dialects with the interface's tables and columns.
- `pnpm test` requires Docker (or a PostgreSQL URL) for the database package.
- One more runtime dependency of the published CLI (`pg`).
- Values that differ between drivers (booleans, counts) must be mapped explicitly in repository
  code.

## Consequences

- `packages/database`: Kysely + `pg` dependencies, `Database` becomes `Kysely<…>`, a
  dialect-neutral `DatabaseHandle` (`openDatabase` for SQLite, `openPostgresDatabase`, and
  `openConfiguredDatabase` choosing by environment), helper functions replace direct
  `handle.sqlite` access in the web app and CLI.
- `drizzle-orm`, `drizzle-kit`, `drizzle.config.ts` and the SQL migration folder are removed;
  the CLI ships compiled migrations instead of SQL files.
- CI runs the browser tests against both backends.
- Delivery in four pull requests, each green at 100% coverage: Kysely on SQLite (no behaviour
  change), PostgreSQL backend in `packages/database`, backend selection in CLI and web, browser
  tests on PostgreSQL.
- ADR-0002 is superseded for its ORM and migration decisions only; SQLite through
  `node:sqlite` remains the default database.

## Status

Proposed. Revisit if Kysely's SQLite dialect cannot cover a needed feature, or when the
self-hosted server mode (ADR-0009) defines connection pooling and multi-user requirements.
