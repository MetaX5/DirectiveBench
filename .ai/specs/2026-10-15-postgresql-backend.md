---
id: SPEC-117
title: Optional PostgreSQL Backend
status: draft
created: 2026-10-15
updated: 2026-10-15
category: feature
related: [SPEC-004, SPEC-006, SPEC-007, SPEC-009, SPEC-010, SPEC-011, SPEC-012, ADR-0001, ADR-0002, ADR-0009, ADR-0011]
---

# SPEC-117 — Optional PostgreSQL Backend

## 1. Summary

DirectiveBench can store its data in PostgreSQL instead of the default SQLite file. SQLite
remains the zero-setup default for `npx directivebench`; PostgreSQL is selected by setting
`DIRECTIVEBENCH_DATABASE_URL`. Both backends share one repository layer and one migration
history ([ADR-0011](../decisions/0011-optional-postgresql-backend-with-kysely.md)) and are tested
against a real PostgreSQL started with testcontainers.

## 2. Motivation and problem statement

The maintainer wants PostgreSQL support now and CI integration tests that start a temporary
instance of the app on a real PostgreSQL. Self-hosting ([SPEC-011](2026-10-14-self-hosting-architecture.md))
will need PostgreSQL; today only SQLite exists, so nothing proves the repository layer is
actually portable as SPEC-006 §6 intends.

## 3. Goals

- Every repository function behaves identically on SQLite and PostgreSQL.
- `npx directivebench` without configuration behaves exactly as before (SQLite in the data dir).
- Existing SQLite data directories keep working without manual steps.
- CI runs unit tests and browser tests against PostgreSQL started by testcontainers.

## 4. Non-goals

- Starting or managing a PostgreSQL server or Docker container from the CLI.
- Migrating data between backends (export/import).
- Multi-user, authentication, workspaces or remote runners ([SPEC-011](2026-10-14-self-hosting-architecture.md)).
- Connection-pool tuning, TLS client certificates, read replicas.
- Portability of the data directory: fixtures, workspaces, logs and local repository paths stay
  on the local machine; a second machine pointed at the same database sees records whose files
  it does not have.
- Sharing a database with other applications: DirectiveBench requires a dedicated, empty
  database (or one it created); migrations fail rather than adopt foreign tables.

## 5. User stories

- As a user with a PostgreSQL server, I set `DIRECTIVEBENCH_DATABASE_URL` and DirectiveBench
  stores its records there, so I can back them up and inspect them with my database tooling.
- As a contributor, I run `pnpm test` and know every repository function works on both backends.

## 6. Functional requirements

| ID | Requirement |
| --- | --- |
| FR-117-01 | Backend selection MUST follow: `DIRECTIVEBENCH_DATABASE_URL` set → PostgreSQL; otherwise SQLite at `<dataDir>/directivebench.db`. |
| FR-117-02 | The URL MUST use the `postgres:` or `postgresql:` scheme; any other value MUST fail with a usage error (exit code 2) naming the variable, without echoing the URL. `doctor` reports an invalid URL as a failing `database` check instead. |
| FR-117-03 | The URL MUST NOT be read from `config.json` or a CLI flag and MUST NOT be written anywhere. `doctor`, logs and error messages MUST show it with the password — in the user-info part and in `password`, `sslpassword` and `sslkey*` query parameters — replaced by `***`. `DIRECTIVEBENCH_DATABASE_URL` counts as a secret environment variable. `PGPASSWORD` and `~/.pgpass` are supported by the driver as password-free URLs. |
| FR-117-04 | `serve` MUST pass the URL to the web child process (through its environment) so the web app and the runner use the same backend. |
| FR-117-05 | `init`, `demo`, `serve` and `doctor` MUST work with either backend. Migrations MUST be applied on startup for both, forward-only, all pending migrations in one transaction. A database migrated by a newer version MUST be refused with a clear downgrade error. |
| FR-117-06 | One migration history MUST produce equivalent schemas on both backends: same tables, columns, primary keys, unique constraints, foreign keys (incl. `ON DELETE`) and indexes as SPEC-006 §3. |
| FR-117-07 | An existing SQLite database whose `__drizzle_migrations` table records exactly the initial migration MUST be adopted without re-running it and without data loss; any other Drizzle history MUST be refused. Until adopted (by `init`, `demo` or `serve`), `doctor` and the web app report it as not migrated. |
| FR-117-08 | Repository functions MUST return identical values on both backends (booleans as `boolean`, counts as `number`, JSON parsed, timestamps as ISO strings) in the same order (PostgreSQL text columns use `COLLATE "C"`, matching SQLite's binary collation). |
| FR-117-08a | `withTransaction` MUST serialise write transactions on PostgreSQL as SQLite does (transaction-scoped advisory lock), so concurrent imports of the same artifact or suite succeed without unique violations. |
| FR-117-09 | Job acquisition MUST stay atomic on PostgreSQL with several runners (no job claimed twice). |
| FR-117-10 | `doctor` MUST report the backend (`sqlite` with the file path, or `postgresql` with the redacted URL) and whether the database is reachable and migrated. |
| FR-117-11 | If PostgreSQL is unreachable at startup (named connect timeout) or migrations fail, the CLI MUST exit with a runtime error (exit code 1) and a hint naming `DIRECTIVEBENCH_DATABASE_URL`, without starting the web server. SQLite open failures keep exit code 5. The web app's `/api/health` returns 503 with `database: "unavailable"` when the server is unreachable. |
| FR-117-12 | A PostgreSQL connection lost after start-up MUST NOT crash the CLI or web process (pool `error` listener); affected requests fail and later ones reconnect. |

## 7. Non-functional requirements

- No native addons: `pg` is used without `pg-native` (SPEC-004 §4).
- SQLite behaviour (WAL, `busy_timeout`, `foreign_keys`, immediate write transactions) is unchanged.
- The packaged CLI starts PostgreSQL-backed `serve` without extra installation steps
  (`pnpm verify:pack` exercises it).

## 8. Domain entities and contracts

No new entities. The physical schema stays as in [SPEC-006](2026-10-14-database-schema.md) §3
with these PostgreSQL column types: `text` → `text COLLATE "C"`, `integer` → `integer` (booleans
stay 0/1), `real` → `double precision`, JSON → `text`, and `fixture_versions.total_bytes` →
`bigint` on both backends. The `DB` TypeScript interface in `packages/database/src/schema.ts` is
the single source for table and column types; a runtime `TABLE_COLUMNS` manifest checked against
it at compile time lets tests compare the migrated schema with the interface.

## 9. Data flow

Unchanged: web (reads, enqueues) and runner (in the CLI process) access the same database
through `@directivebench/database`. With PostgreSQL, each process holds its own `pg` pool.

## 10. API and interface design

`@directivebench/database` exports:

- `openDatabase(path, options?)` — SQLite (as today).
- `openPostgresDatabase(url, options?)` — PostgreSQL.
- `openConfiguredDatabase({ dataDir, env })` — chooses by FR-117-01.
- `DatabaseHandle` — `{ db, dialect: 'sqlite' | 'postgresql', description, close(): Promise<void> }`;
  no raw driver handle is exposed to callers. `description` is the SQLite path or the redacted URL.
- `openConfiguredDatabase` takes `{ mustExist }` so the web app never creates a SQLite file.
- `migrateDatabase(handle)` — applies the bundled migrations.
- `getMigrationState(handle)` — `{ migrated: boolean, applied: number }` for `doctor` and the web app.
- `redactDatabaseUrl(url)`.
- Repository functions keep their names, parameters and return types.

## 11. UI/UX considerations

Settings shows the backend and, for PostgreSQL, the redacted URL instead of the SQLite path.

## 12. Security considerations

The URL contains credentials ([SPEC-007](2026-10-14-security-and-privacy.md),
[ADR-0008](../decisions/0008-secret-storage-and-authentication.md)): environment only, redacted
in output, never persisted. TLS options are passed through the URL (`sslmode`); TLS verification
is never disabled by DirectiveBench.

## 13. Error handling

Invalid URL → usage error (FR-117-02). Unreachable server or failed migration → runtime error with
the redacted URL and the driver's message. Query errors propagate as today.

## 14. Edge cases

- `DIRECTIVEBENCH_DATABASE_URL` set to an empty string → treated as unset (SQLite).
- Two CLIs (two runners) against one PostgreSQL database → atomic acquisition (FR-117-09). Under
  READ COMMITTED a runner that loses a race for the same job gets no job for that poll even if
  other jobs are pending; it retries on the next poll.
- A Drizzle-created SQLite database with additional unknown migrations → refuse with an error
  rather than guessing.

## 15. Testing strategy

- `packages/database`: every repository and client test runs against SQLite and PostgreSQL
  (Vitest projects; `DIRECTIVEBENCH_TEST_POSTGRES_URL` or `@testcontainers/postgresql`, one
  container per package run, one database per test cloned from a migrated template); schema
  equivalence of both dialects with `TABLE_COLUMNS` and of the new SQLite migration with the old
  Drizzle SQL (FR-117-06); adoption of a Drizzle-created SQLite database (FR-117-07); mixed-case
  ordering (FR-117-08); concurrent imports (FR-117-08a).
- `packages/runner`: N runners against M jobs on one PostgreSQL database — every job claimed
  once (`attempts = 1`) and completed (FR-117-09).
- `apps/cli`: backend selection, URL validation and redaction, `doctor` output.
- Browser tests: the full Playwright suite against a temporary instance on PostgreSQL, started by
  `apps/web/e2e/run-postgres.mjs` (testcontainers) before `playwright test`; CI runs the `e2e` job
  as a matrix over both backends.
- 100% coverage gate as everywhere ([SPEC-012](2026-10-14-testing-strategy.md) §3).

## 16. Acceptance criteria

- [ ] AC-1: Without `DIRECTIVEBENCH_DATABASE_URL`, all existing tests and `pnpm verify:pack` pass unchanged.
- [ ] AC-2: Every repository test passes on both backends; coverage stays 100%.
- [ ] AC-3: The schema equivalence test passes (FR-117-06).
- [ ] AC-4: A SQLite database created by the previous Drizzle migration is adopted and its data readable (FR-117-07).
- [ ] AC-5: The Playwright suite passes against a PostgreSQL-backed instance in CI.
- [ ] AC-6: `doctor` shows the redacted URL; no output or log contains the password (FR-117-03, FR-117-10).
- [ ] AC-7: An invalid URL exits 2; an unreachable server exits 1 with the hint (FR-117-02, FR-117-11).

## 17. Dependencies

ADR-0011; `kysely`, `pg`; dev: `@testcontainers/postgresql`. Docker for running the tests.

## 18. Open questions

- None. `verify:pack` exercises the packed CLI against PostgreSQL when Docker is available and
  says so explicitly when it skips that step.

## 19. Future extensions

Backend-to-backend data migration; pool configuration; PostgreSQL-specific acquisition with
`FOR UPDATE SKIP LOCKED` if the lost-race empty polls matter; making `finishJob` conditional on
`status = 'running'` (it can overwrite `interrupted` set by another runner's stale recovery).

## 20. Implementation status

- **Not implemented.**
