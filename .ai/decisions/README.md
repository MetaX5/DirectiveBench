# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for DirectiveBench.

## ADRs vs specs

| Location | Answers | Example |
| --- | --- | --- |
| `.ai/decisions/` (ADRs) | **Why** a significant technical decision was made, which alternatives were rejected, and what it costs us | "Why SQLite through `node:sqlite` and not PostgreSQL or better-sqlite3?" |
| [`.ai/specs/`](../specs) | **What** the system must do and how its parts behave | "Which tables exist and what are their constraints?" |

An ADR records a decision at a point in time. A spec describes the current intended behaviour and is
updated as the system evolves. When a spec depends on a decision, it links to the ADR instead of
repeating the rationale.

## Index

| Number | Title | Status | Date |
| --- | --- | --- | --- |
| [ADR-0001](0001-local-first-architecture.md) | Local-first architecture | Accepted | 2026-10-14 |
| [ADR-0002](0002-sqlite-with-node-sqlite.md) | SQLite with built-in `node:sqlite` | Accepted | 2026-10-14 |
| [ADR-0003](0003-monorepo-architecture.md) | Monorepo with pnpm workspaces and Turborepo | Accepted | 2026-10-14 |
| [ADR-0004](0004-native-cli-distribution.md) | Native npm CLI distribution | Accepted | 2026-10-14 |
| [ADR-0005](0005-custom-benchmark-engine.md) | Custom benchmark engine (Promptfoo optional) | Accepted | 2026-10-14 |
| [ADR-0006](0006-agent-adapters-vs-model-providers.md) | Agent adapters are separate from model providers | Accepted | 2026-10-14 |
| [ADR-0007](0007-local-runner-execution-and-isolation.md) | Local runner execution and isolation | Accepted | 2026-10-14 |
| [ADR-0008](0008-secret-storage-and-authentication.md) | Secret storage and authentication modes | Proposed | 2026-10-14 |
| [ADR-0009](0009-self-hosted-readiness.md) | Self-hosted readiness boundaries | Proposed | 2026-10-14 |
| [ADR-0010](0010-mit-license.md) | MIT license | Accepted | 2026-10-14 |
| [ADR-0011](0011-optional-postgresql-backend-with-kysely.md) | Optional PostgreSQL backend, one repository layer on Kysely | Proposed | 2026-10-15 |

ADR-0001 to ADR-0010 were written during project bootstrap; all ADRs above are pending maintainer
review (see the "Deciders" field in each record).

## Statuses

| Status | Meaning |
| --- | --- |
| Proposed | Under discussion or not yet implemented/validated. Code must not assume it is final. |
| Accepted | Agreed and in effect. New code must follow it. |
| Superseded | Replaced by a newer ADR. The record states `Superseded by ADR-NNNN` and is kept unchanged otherwise. |
| Deprecated | No longer relevant (e.g. the affected component was removed) and not replaced by another ADR. |

## Adding a new ADR

1. Take the next sequential number (highest existing number + 1), zero-padded to four digits.
   Numbers are never reused and ADRs are never renumbered.
2. Create `NNNN-short-kebab-title.md` using the template below.
3. Start with `Status: Proposed`. Change it to `Accepted` once maintainers agree.
4. Add a row to the index table above.
5. Do not rewrite the history of an Accepted ADR. To change a decision, write a new ADR that
   supersedes it, then set the old ADR's status to `Superseded by ADR-NNNN` (the only edit allowed
   on the old record besides fixing typos or broken links).
6. Link the ADR from the affected specs in [`.ai/specs/`](../specs), and link the specs from the ADR.

## Template

```markdown
# ADR-NNNN: Title

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Deciders:** <names or roles>
- **Related:** <links to specs / other ADRs>

## Context

What problem forces a decision? Constraints, facts, requirements.

## Decision

What we decided, stated concretely.

## Alternatives considered

- **Option A** — why it was not chosen.
- **Option B** — why it was not chosen.

## Benefits

## Drawbacks

## Consequences

What changes for code, specs, users and future decisions.

## Status

Current status and any conditions for revisiting it.
```
