# Backward compatibility

The surfaces DirectiveBench treats as **protected contracts**, what counts as a breaking change
on each, and the path a breaking change must take. Review skills (`om-code-review`,
`om-auto-review-pr`) check every touched surface against this file and treat a break without its
path as a blocker; implementation skills warn before making one.

**Release status:** the only published package is the `directivebench` CLI (`apps/cli`,
version 0.1.0), and nothing has been published to npm yet (SPEC-009 §12). Users can still have
data directories created from source checkouts, so the persisted-data rules (§2–§5) apply
already.

## Versioning policy

`directivebench` follows [Semantic Versioning](https://semver.org/). The workspace packages are
private and unversioned for compatibility purposes.

| Change | While `0.y.z` | From `1.0.0` |
| --- | --- | --- |
| Breaking change to a protected surface (§1, §6) | minor (`0.1 → 0.2`) | major |
| New command, option, field or format feature | patch | minor |
| Bug fix, internal change | patch | patch |
| Breaking change to persisted data (§2–§5) | never — migrate forward instead, at any version | never — migrate forward instead |

Persisted data is exempt from the usual pre-1.0 freedom on purpose: a `0.y` bump can rename a
flag, but it must never strand a user's data directory, config or benchmark suites. `1.0.0` is
cut deliberately by the maintainer once the CLI surface (§1) and benchmark format v1 (§3) are
considered stable.

**Deprecation window.** A removed or renamed CLI command, option or env var stays as an alias
that prints a deprecation warning naming its replacement: for at least one minor release while
`0.y.z` (deprecated in `0.2`, removable in `0.3`), and until the next major from `1.0.0`. Exit
code numbers are never reused, and `doctor --json` fields are only removed under the same window.

A breaking change always ships with, in the same PR: the owning spec updated, a migration note in
the PR body (carried into `CHANGELOG.md` at release by `om-auto-update-changelog`), and a test
proving the old input still works or fails with a clear, actionable message.

## 1. CLI — `directivebench` (owner: [SPEC-009](.ai/specs/2026-10-14-cli-architecture.md))

Surface: commands `serve` (default), `init`, `doctor`, `demo`, `--help`, `--version`; global
`--data-dir`; serve options `--host`, `--port`, `--no-open`, `--allow-network-access`, `--dev`;
`doctor --json` output `{ "checks": [{ name, status, detail, hint? }] }`; exit codes 0–6
(`ExitCode` in `apps/cli/src/runtime.ts`); environment variables `DIRECTIVEBENCH_HOST`,
`DIRECTIVEBENCH_PORT`, `DIRECTIVEBENCH_DATA_DIR`, `DIRECTIVEBENCH_ALLOWED_HOSTS`; precedence
flag > env > `config.json` > default; supported Node range (`>=22.16.0`).

- **Breaking:** removing or renaming a command, option or env var; changing an option's meaning
  or default; changing an exit code's meaning or reusing a number; removing or renaming a
  `doctor --json` field; raising the minimum Node version; making `init` or `doctor` stop being
  idempotent / read-only.
- **Not breaking:** new commands, options, env vars, exit codes, or optional `doctor --json`
  fields; human-readable output wording.
- **Path:** keep the old name as a deprecated alias for the deprecation window above; update
  SPEC-009 §2/§3/§9 and `runtime.ts` together (SPEC-009 §9 requires the exit-code table and the
  code to match); cover both names in `apps/cli/test/`.

## 2. `config.json` (owner: [SPEC-115](.ai/specs/2026-10-14-settings-and-configuration.md))

Surface: the file in the data directory, versioned by `configVersion: 1`, validated by
`configSchema` in `packages/core/src/config.ts`.

- **Breaking:** any change that makes a valid v1 file invalid or changes the meaning of a field
  or default.
- **Not breaking:** new optional fields whose default keeps current behaviour.
- **Path:** bump `configVersion` and migrate forward on load, backing up the old file first
  (FR-115-13). A file with a newer `configVersion` than the CLI knows is rejected with an
  upgrade message, never rewritten.

## 3. Benchmark definition format v1 (owner: [SPEC-108](.ai/specs/2026-10-14-benchmark-definition-format.md))

Surface: YAML/JSON documents with `schemaVersion: 1`, validated by `benchmarkDefinitionSchema`
in `packages/benchmark-engine/src/definition.ts`, plus the fixture/verification path rules and
the mock-agent playbook semantics.

- **Breaking:** changing a field's type, a default's meaning, or validation strictness in a way
  that rejects a previously valid document; changing assertion semantics so an existing suite
  scores differently.
- **Not breaking:** additive optional fields whose default preserves behaviour (SPEC-108 §8.4).
- **Path:** `schemaVersion: 2` plus a pure, tested `v1 → v2` step in
  `migrateDefinitionDocument`, documented in SPEC-108. Stored suite versions
  (`benchmark_suite_versions.definition`) are never mutated; old versions migrate in memory.

## 4. Database schema and migrations (owner: [SPEC-006](.ai/specs/2026-10-14-database-schema.md))

Surface: the SQLite database in the data directory, `packages/database/src/schema.ts` and the
migrations in `packages/database/migrations/` (shipped inside the CLI package and applied at
startup).

- **Breaking:** editing, reordering or deleting a migration that has been merged to `main`;
  dropping or renaming a column/table that holds user data without a data-preserving migration;
  mutating immutable records (artifact versions, suite versions, fixture snapshots); changing ID
  prefixes.
- **Path:** forward-only — a new migration generated with `pnpm db:generate`, reviewed and
  committed with its snapshot; data backfills in that migration; a test that migrates a database
  created by the previous schema. Planned (SPEC-006 §5): pre-migration backups and downgrade
  detection.

## 5. Persisted job payloads and data-directory layout

Surface: `jobs.payload` JSON (parsed by `benchmarkJobPayloadSchema`) — a job enqueued by one
version can be executed after an upgrade; the data-directory layout of
[SPEC-010 §5](.ai/specs/2026-10-14-local-installation.md#5-data-directory) (`config.json`,
`directivebench.db`, `fixtures/<sha256>/`, `logs/`).

- **Breaking:** a payload schema that rejects pending jobs written by the previous version;
  moving or renaming files in the data directory; changing fixture content addressing.
- **Path:** accept the old payload shape (or mark such jobs failed with a clear reason, never
  crash the runner); move data-directory files with a migration step at startup.

## 6. HTTP surface (owner: [SPEC-008](.ai/specs/2026-10-14-api-architecture.md))

Surface: `GET /api/health` → `{ status: "ok", database: "ready" | "not-initialized" }`, polled
by the CLI for readiness; the planned `/api/v1/*` JSON API.

- **Breaking:** changing the health route's path or fields; any non-additive change under
  `/api/v1`.
- **Path:** `/api/v2` for breaking API changes (SPEC-008 §4); additive fields only within v1.

## Not protected

- **Workspace packages** (`@directivebench/core`, `database`, `agent-adapters`,
  `benchmark-engine`, `runner`) are private and consumed only inside this monorepo. Change their
  exports freely, updating every consumer in the same PR. The dependency direction between them
  is an architecture rule (SPEC-003), not a compatibility one.
- **Server actions and web page paths** in `apps/web` have no external consumers.
- **Human-readable CLI and UI text**, log line wording (but not `runner.log`'s JSON-lines
  format, which users may parse — treat field removals there as breaking).
