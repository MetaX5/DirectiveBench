# ADR-0007: Local runner execution and isolation

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Benchmark execution](../specs/features/benchmark-execution.md),
  [Runner management](../specs/features/runner-management.md),
  [Security and privacy](../specs/foundation/security-and-privacy.md),
  [Database schema](../specs/foundation/database-schema.md),
  [ADR-0002](0002-sqlite-with-node-sqlite.md), [ADR-0009](0009-self-hosted-readiness.md)

## Context

Benchmarks run coding agents and verification commands that read and write files and spawn
processes. Runs take seconds to many minutes, must survive UI reloads, be cancellable, and must not be
lost silently if the process crashes. The web process (Next.js) must stay responsive and must not
execute benchmarks itself.

Running untrusted or semi-trusted commands on the host is inherently risky. DirectiveBench will also
import benchmark definitions and artifacts from repositories the user does not fully control.

## Decision

**Job queue and runner**

- Jobs are rows in the SQLite `jobs` table. Statuses: `pending`, `running`, `completed`, `failed`,
  `cancelled`, `interrupted`.
- The web UI only **enqueues** jobs. The runner (`packages/runner`) runs **in-process inside the CLI**
  (`serve`, `demo`), polling the database.
- Acquisition is atomic: `UPDATE … SET status = 'running' … WHERE status = 'pending' … RETURNING`.
- Heartbeat every 5 s. On runner start, `running` jobs with a heartbeat older than 30 s become
  **`interrupted`**; there is no automatic retry, the user can re-run.
- Cancellation sets `cancel_requested_at`; the runner aborts via `AbortSignal` and marks the job
  `cancelled`. Graceful shutdown (SIGINT/SIGTERM) aborts active jobs and marks them `interrupted`.
- Bounded concurrency via `runner.concurrency` (default 1).

**Execution safety**

- The `local-process` environment is **not a sandbox**. The UI and reports label it
  "Not sandboxed", and run metadata records `sandboxed = false`.
- `docker` environment is planned; until implemented the runner rejects such jobs with a clear error.
- Commands (setup and `command` assertions) run **only** from benchmark suite versions marked
  **execution-approved**. Bundled examples are approved at import; user approval UX is planned.
- Commands run as argv without a shell, `cwd` = the temporary workspace, environment restricted to an
  allowlist (`PATH`, `LANG`, `TZ`, with `HOME` pointed at a workspace-local temp directory), with a
  timeout, process kill, and truncated, redacted output.
- **Never auto-run scripts from imported repositories** (package scripts, hooks, Makefiles, fixture
  scripts). Discovery and import only read files.
- Workspaces are fresh copies of content-addressed fixture snapshots under the OS temp directory;
  symlinks and paths escaping the fixture root are rejected at import.

## Alternatives considered

- **Redis + BullMQ.** Robust queues, but adds a server dependency, contradicting zero-setup
  ([ADR-0001](0001-local-first-architecture.md)); local throughput needs are tiny.
- **In-memory queue.** No persistence; jobs lost on crash with no record.
- **Separate runner process/daemon locally.** Better fault isolation but more lifecycle management;
  deferred to the standalone `directivebench runner` command ([ADR-0009](0009-self-hosted-readiness.md)).
- **Executing jobs inside Next.js route handlers/server actions.** Ties long-running work to the web
  server lifecycle and request model.
- **Docker-only execution from day one.** Safer, but requires Docker for the first run and cannot
  use host-authenticated agent CLIs without mounting credentials.
- **Automatic retry of interrupted jobs.** Could re-run side-effecting commands unexpectedly;
  explicit re-run is safer.

## Benefits

- No extra infrastructure; job state is durable and visible in the UI.
- Crash behaviour is explicit and conservative (`interrupted`, no silent retries).
- Clear, honest safety posture; approval gate limits what can execute.

## Drawbacks

- `local-process` runs agents and commands with the user's privileges; a malicious approved
  definition or a misbehaving agent can damage the host. Mitigated only by approval and labelling
  until Docker exists.
- Polling SQLite adds small latency; single-writer SQLite limits parallel throughput.
- Runner shares the CLI process; a crash takes both down (recovered on next start).

## Consequences

- Specs and UI must never describe `local-process` as isolated.
- Every new command-executing feature must go through the approval gate and argv/env/timeout rules.
- The job contract (acquire, heartbeat, cancel, complete) is designed so a remote runner can use it
  over an API later.

## Status

Accepted.
