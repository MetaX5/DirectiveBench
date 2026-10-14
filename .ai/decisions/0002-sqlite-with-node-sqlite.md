# ADR-0002: SQLite with built-in `node:sqlite`

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Database schema](../specs/2026-10-14-database-schema.md),
  [Technology stack](../specs/2026-10-14-technology-stack.md),
  [Self-hosting architecture](../specs/2026-10-14-self-hosting-architecture.md),
  [ADR-0001](0001-local-first-architecture.md), [ADR-0004](0004-native-cli-distribution.md),
  [ADR-0007](0007-local-runner-execution-and-isolation.md)

## Context

The local-first MVP ([ADR-0001](0001-local-first-architecture.md)) needs durable relational storage
for artifacts, immutable versions, benchmark suites, jobs and results. Requirements:

- zero external services: `npx directivebench` must work without installing a database server;
- no native compilation or prebuilt-binary download during `npx` installs, which fail on uncommon
  platforms, behind proxies, or when the Node ABI changes;
- two processes access the same data concurrently: the CLI process (job runner) and the spawned
  Next.js server (UI reads, job enqueue);
- typed schema and generated SQL migrations;
- a realistic path to PostgreSQL for a future self-hosted server ([ADR-0009](0009-self-hosted-readiness.md)).

Environment facts (verified 2026-10-14): Node 24 LTS ships `node:sqlite` (`DatabaseSync`).
Drizzle ORM 0.45 (stable) has no `node:sqlite` driver; Drizzle 1.0, which adds one, is still a
release candidate.

## Decision

- **Database:** SQLite, one file `directivebench.db` in the data directory.
- **Driver:** Node's built-in `node:sqlite`, wrapped by Drizzle's **`sqlite-proxy`** driver. The
  proxy callback executes Drizzle-generated SQL through `DatabaseSync` prepared statements and
  returns rows in the shape Drizzle expects.
- **ORM and migrations:** Drizzle ORM 0.45 schema in `packages/database`; SQL migrations generated
  by drizzle-kit 0.31, shipped with the CLI and applied on startup.
- **Concurrency settings:** `journal_mode = WAL`, `busy_timeout` set on every connection,
  `foreign_keys = ON`. Writes are short transactions; job acquisition is a single atomic
  `UPDATE … WHERE status = 'pending' … RETURNING`.
- **Persistence boundary:** application code (web, runner, CLI) uses repository functions exported
  by `@directivebench/database`, never raw SQL or Drizzle queries directly. SQLite-specific details
  stay inside the package.
- **Future PostgreSQL:** a server mode may add a PostgreSQL implementation behind the same repository
  functions. Schema conventions are chosen to port cleanly: prefixed random text IDs (`art_…`),
  ISO-8601 UTC text timestamps, JSON stored as text, no SQLite-only features in domain logic.

## Alternatives considered

- **PostgreSQL for MVP.** Rejected: requires a server or Docker for every user, contradicting
  `npx` zero-setup.
- **better-sqlite3.** Mature and fast, but a native addon: relies on prebuilt binaries per
  platform/Node ABI, falls back to `node-gyp` compilation, and breaks when users switch Node versions
  under an `npx` cache. Drizzle supports it directly, which was the main argument for it.
- **@libsql/client.** Avoids node-gyp but still ships platform-specific native binaries; adds a
  dependency whose remote/replication features we do not need.
- **PGlite** (Postgres in WASM). No native code and Postgres semantics, but larger footprint,
  single-connection model that does not fit two processes sharing one database, and less mature
  multi-process story.
- **Drizzle 1.0 RC with native `node:sqlite` driver.** Rejected for now: pre-release. Revisit when
  1.0 is stable; switching is internal to `packages/database`.
- **Raw `node:sqlite` without an ORM.** Rejected: loses typed schema and migration generation.

## Benefits

- No native modules in the dependency tree for storage; installs are pure JavaScript.
- No database server; backup is copying files.
- WAL allows concurrent reads from the web process while the runner writes.
- Typed queries and generated migrations via Drizzle despite the missing native driver.

## Drawbacks

- `node:sqlite` requires a recent Node (24 LTS assumed; `doctor` validates the runtime) and its API
  was marked experimental/release-candidate in earlier Node lines.
- `sqlite-proxy` is a thin adapter we own: row-shape mapping, transactions and batch behaviour must
  be covered by tests in `packages/database`.
- `DatabaseSync` is synchronous; long queries block the event loop. Acceptable for local data
  volumes; queries must stay small and indexed.
- SQLite allows one writer at a time; heavy parallel writes would contend (bounded by
  `busy_timeout`).

## Consequences

- `packages/database` owns the driver adapter, schema, migrations and repository functions; other
  packages depend on its exported functions and types only.
- The CLI runs migrations before starting the runner and the web server.
- Moving to Drizzle 1.0's native driver, or adding PostgreSQL, is a change inside the database
  package plus a new ADR if behaviour differs.

## Status

Accepted. Revisit when Drizzle 1.0 is stable or when the self-hosted server mode is designed.
