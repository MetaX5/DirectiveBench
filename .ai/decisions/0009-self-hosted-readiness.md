# ADR-0009: Self-hosted readiness boundaries

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Self-hosting architecture](../specs/foundation/self-hosting-architecture.md),
  [System architecture](../specs/foundation/system-architecture.md),
  [Runner management](../specs/features/runner-management.md),
  [ADR-0001](0001-local-first-architecture.md), [ADR-0002](0002-sqlite-with-node-sqlite.md),
  [ADR-0007](0007-local-runner-execution-and-isolation.md),
  [ADR-0008](0008-secret-storage-and-authentication.md)

## Context

DirectiveBench is local-first ([ADR-0001](0001-local-first-architecture.md)). Teams will eventually
want a shared, self-hosted server (shared artifact registry, shared results) with runners on
developer machines, CI agents or dedicated hosts. Building that now would add authentication,
multi-tenancy, PostgreSQL, distributed queues and deployment tooling that the MVP does not need.
Ignoring it entirely would bake single-process assumptions into the code and make the server mode a
rewrite.

## Decision

Do **not** build server or distributed infrastructure now. Keep these boundaries so it stays
practical:

1. **Persistence behind repositories.** All reads/writes go through repository functions in
   `@directivebench/database` ([ADR-0002](0002-sqlite-with-node-sqlite.md)); a PostgreSQL
   implementation can be added behind them. No SQL in web, runner or CLI code.
2. **Runner contracts usable remotely.** The job lifecycle (acquire, heartbeat, report events and
   results, observe cancellation, complete/fail) is defined as a contract with serializable inputs and
   outputs. The local runner calls it in-process; a remote runner would call the same operations over
   an authenticated API. The benchmark engine already has no DB/UI dependency.
3. **Outbound-only runner connections.** Future remote runners initiate authenticated connections to
   the server (polling or long-lived outbound connection). **Runners expose no inbound ports.**
4. **Credentials stay in the trusted execution environment.** Agent logins and API keys live on the
   runner host ([ADR-0008](0008-secret-storage-and-authentication.md)); the server never receives
   or stores them. Results sent to the server are redacted.
5. **Identifiers and data are portable.** Prefixed random IDs, UTC ISO-8601 timestamps,
   content-addressed fixtures and immutable versions allow merging data from multiple runners.
6. **No distributed infrastructure now:** no Redis, message brokers, Kubernetes manifests or
   multi-user auth in the MVP.

## Alternatives considered

- **Build self-hosted mode in parallel with the MVP.** Doubles scope before the core value is proven.
- **Ignore server mode until needed.** Cheaper now, but direct DB access from UI/runner and
  in-process-only assumptions would require broad refactoring later.
- **Server pushes jobs to runners (inbound connections).** Requires opening ports on developer and
  CI machines and exposes them to the network; rejected in favour of outbound-only.
- **Centralized credential vault on the server.** Concentrates high-value secrets and conflicts with
  Local Subscription Mode; rejected.

## Benefits

- Low current cost: the boundaries are mostly code-organization rules.
- A future server can reuse the engine, runner and domain types.
- Security posture for remote runners is decided before any network code exists.

## Drawbacks

- Some indirection (repository functions, serializable contracts) that a pure local app would not
  need.
- Boundaries are untested until a second implementation (PostgreSQL, remote runner) exists; they
  may leak SQLite- or process-specific assumptions.

## Consequences

- Code review checks: no SQL outside `packages/database`; runner ↔ engine ↔ persistence exchange
  plain serializable data; no secrets in job payloads or results.
- The self-hosting spec describes the target topology; it is a design, not an implementation.
- When server mode is started, a new ADR records the concrete choices (database, auth, transport).

## Status

Proposed. Accept after maintainer review of the self-hosting spec; bootstrap code is intended to
follow these boundaries already where applicable.
