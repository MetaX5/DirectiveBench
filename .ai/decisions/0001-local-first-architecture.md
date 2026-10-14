# ADR-0001: Local-first architecture

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Project overview](../specs/2026-10-14-project-overview.md),
  [System architecture](../specs/2026-10-14-system-architecture.md),
  [Security and privacy](../specs/2026-10-14-security-and-privacy.md),
  [Local installation](../specs/2026-10-14-local-installation.md),
  [ADR-0009](0009-self-hosted-readiness.md)

## Context

DirectiveBench discovers, versions and benchmarks AI agent artifacts (skills, instructions, rules)
across repositories, coding agents and models. The data it touches is sensitive by nature:

- private repository contents and fixtures;
- instruction files that encode a team's internal practices;
- credentials for model providers and authenticated coding-agent CLIs
  (Claude Code, Codex, Cursor Agent) that already live on the developer's machine;
- benchmark execution, which runs agents and verification commands against real workspaces.

The target users are developers and small teams who want to try the tool in minutes, without
creating an account, provisioning infrastructure or trusting a third party with their code.

## Decision

DirectiveBench is **local-first**:

- It runs entirely on the user's machine via `npx directivebench`. The CLI starts a local web UI
  bound to `127.0.0.1` (default port 4280).
- There is no DirectiveBench cloud service, no account and no telemetry in the MVP.
- All state lives in a per-user data directory (OS-specific default, overridable with
  `--data-dir` / `DIRECTIVEBENCH_DATA_DIR`): `config.json`, the SQLite database, content-addressed
  fixture snapshots, logs.
- Agents and verification commands run on the user's machine, using CLIs and credentials the user
  already has (see [ADR-0008](0008-secret-storage-and-authentication.md)).
- Binding to a non-loopback address requires an explicit `--allow-network-access` flag, because the
  MVP has no authentication. A Host-header allowlist in `proxy.ts` protects against DNS rebinding.
- A self-hosted shared server and remote runners are a future option; the local architecture keeps
  boundaries that make them practical ([ADR-0009](0009-self-hosted-readiness.md)).

## Alternatives considered

- **Cloud-first SaaS** (hosted UI, hosted runners, hosted database). Rejected: requires users to
  upload private code and credentials, requires accounts, billing and operations, and cannot use
  subscription-authenticated local agent CLIs without copying their credentials.
- **Hybrid with mandatory cloud sync.** Rejected for MVP: adds an account and a network dependency
  for no benefit to a single user; sharing can be addressed later by self-hosting.
- **Self-hosted server as the only mode** (Docker Compose with Postgres/Redis). Rejected for MVP:
  too much setup for evaluation; covered as a later mode.

## Benefits

- No code, artifacts or credentials leave the machine unless the user's agent/model calls do so.
- Zero setup beyond Node.js; works offline for everything except agent/model calls.
- Real agent CLIs can be benchmarked in their actual, already-authenticated environment.
- No hosting cost or operational burden for an open-source project.

## Drawbacks

- No built-in sharing or collaboration in the MVP.
- Results depend on the local environment (OS, installed tools, user-level agent configuration);
  this must be recorded as run metadata and surfaced as comparability warnings.
- Execution on the host is not isolated until a Docker environment exists
  ([ADR-0007](0007-local-runner-execution-and-isolation.md)).
- The application cannot be upgraded or patched centrally; users update the npm package.

## Consequences

- The web UI and runner must assume a single trusted local user; any network exposure is opt-in and
  documented as unauthenticated.
- Every persisted path is under the data directory or the OS temp directory; nothing writes to
  repositories the user registered unless an explicit sync/write feature is invoked.
- Secrets handling is designed for a local machine first (OS credential store, environment
  variables), see [ADR-0008](0008-secret-storage-and-authentication.md).
- Persistence and runner contracts are kept behind boundaries so a server mode can be added
  without rewriting the domain ([ADR-0002](0002-sqlite-with-node-sqlite.md),
  [ADR-0009](0009-self-hosted-readiness.md)).

## Status

Accepted. Revisit only if a hosted offering becomes a project goal, which would be a new ADR.
