---
id: SPEC-001
title: Project Overview
status: draft
created: 2026-10-14
updated: 2026-10-14
category: foundation
related: [SPEC-002, SPEC-003, SPEC-004, SPEC-005, SPEC-007, SPEC-013, SPEC-101, SPEC-107, SPEC-112, SPEC-113]
---

# Project Overview

## 1. Identity

| Item | Value |
|---|---|
| Name | DirectiveBench |
| npm package | `directivebench` (the only publishable package; source in `apps/cli`) |
| CLI binary | `directivebench` (run without install via `npx directivebench`) |
| License | MIT — see repository `LICENSE` and [ADR-0010](../../decisions/0010-mit-license.md) |
| Repository layout | pnpm + Turborepo monorepo — see [SPEC-003](./system-architecture.md) |

## 2. Description

DirectiveBench is a **local-first, open-source workbench** for discovering, organizing, synchronizing, testing and benchmarking AI agent **skills, instructions and rules** across repositories, coding agents and AI models.

It runs entirely on the user's machine: `npx directivebench` starts a CLI process that migrates a local SQLite database, starts a job runner and serves a web UI on `http://127.0.0.1:4280`. There is no cloud service, no account and no telemetry ([ADR-0001](../../decisions/0001-local-first-architecture.md)). A self-hosted shared server with remote runners is a future direction ([SPEC-011](./self-hosting-architecture.md)), not part of the MVP.

## 3. Vision — questions the product answers

1. **What instruction artifacts do I have?** Which skills, `AGENTS.md`/`CLAUDE.md` files, Cursor rules and Copilot instructions exist across my repositories, and where is each one used?
2. **Which version is where?** Has the same skill drifted between repositories? Which exact content (hash) is installed at which path and commit?
3. **Does this artifact actually help?** For a given task, does an agent with the artifact installed (GREEN) outperform the same agent without it (RED)?
4. **Did a change make it better or worse?** Does a new artifact version improve, regress or leave unchanged the benchmark results compared to the previous version?
5. **Does it generalize?** How does the artifact behave across agents (Claude Code, Codex, Cursor) and models — measured only where results are comparable?
6. **How much can I trust the result?** How many repetitions, how stable, what was not controlled?

## 4. Capabilities

| Capability | Purpose | Primary specs |
|---|---|---|
| **Artifact Registry** | Discover artifacts in repositories, track logical identity, occurrences and immutable content versions; categorize and tag. | [SPEC-101](../features/artifact-registry.md), [SPEC-102](../features/artifact-discovery.md), [SPEC-103](../features/artifact-versioning.md), [SPEC-104](../features/repository-management.md), [SPEC-105](../features/repository-synchronization.md), [SPEC-106](../features/category-management.md) |
| **Benchmark Engine** | Define benchmark suites (YAML/JSON), snapshot fixtures, run RED/GREEN evaluations through agent adapters, verify with assertions, score and compare. | [SPEC-107](../features/benchmark-engine.md), [SPEC-108](../features/benchmark-definition-format.md), [SPEC-110](../features/benchmark-execution.md), [SPEC-111](../features/benchmark-scoring.md), [SPEC-112](../features/red-green-evaluation.md), [SPEC-114](../features/runner-management.md) |
| **Quality Dashboard** | Web UI that shows artifacts, benchmarks, executions, RED vs GREEN comparisons, traces and quality status per artifact version. | [SPEC-113](../features/results-and-reporting.md), [SPEC-116](../features/dashboard-and-navigation.md) |

## 5. Audiences

- **Individual developers** who maintain personal skills/rules for one or more coding agents and want evidence that an instruction helps before relying on it. MVP target.
- **Teams** that share artifacts across many repositories and want drift detection, a shared catalogue and regression checks on artifact changes. Partly served by the local tool (shared repositories as source of truth); fully served later by the self-hosted server ([SPEC-011](./self-hosting-architecture.md)).

Personas and use cases: [SPEC-002](./product-requirements.md).

## 6. Core principles (condensed)

1. **Local-first.** Everything runs on the user's machine; no account, no hosted backend required.
2. **Privacy by default.** No telemetry. Nothing leaves the machine except user-initiated git and provider calls ([SPEC-007](./security-and-privacy.md)).
3. **Honesty over appearance.** No fake features or decorative buttons. Unimplemented areas say "Planned — not implemented". Mock-agent results are labelled "Mock agent — not an AI evaluation".
4. **Measure the delta, not the absolute.** An artifact is evaluated by RED (baseline, no artifact) vs GREEN (candidate, artifact installed) under identical conditions ([SPEC-112](../features/red-green-evaluation.md)).
5. **Comparability is enforced.** Results with different comparability keys are never aggregated or ranked together. No global cross-suite rankings.
6. **Reproducibility.** Every result references exact immutable versions: artifact version, suite version, fixture hashes, adapter version, model configuration, environment, limits.
7. **Immutability.** Artifact versions, suite versions and fixture snapshots are never mutated; changes create new versions.
8. **Deterministic first.** Prefer deterministic assertions. Nondeterministic evaluators (LLM judge, planned) must record judge model, rubric and prompt version.
9. **Report uncertainty.** Repetitions, standard deviation, confidence level and uncontrolled differences are shown with every verdict ([SPEC-111](../features/benchmark-scoring.md)).
10. **Separate definition from execution.** Suites/cases/fixtures describe *what* to test; jobs/runs/results record *what happened*.
11. **Agent adapters are not model providers.** An agent harness (Claude Code, Codex, Cursor, Mock) and a model API (Anthropic, OpenAI, …) are distinct extension points ([ADR-0006](../../decisions/0006-agent-adapters-vs-model-providers.md)).
12. **Safe execution by default.** Benchmark commands run only for execution-approved suite versions, as argv (no shell), with an environment allowlist, timeouts and output limits. `local-process` is labelled "Not sandboxed".
13. **Secure localhost.** Bind to `127.0.0.1`; non-loopback requires `--allow-network-access`; Host-header allowlist against DNS rebinding.
14. **Secrets never in plaintext.** No secrets in the database, logs, traces or reports; redaction applied to captured output ([ADR-0008](../../decisions/0008-secret-storage-and-authentication.md)).
15. **Repositories are the source of truth; user metadata is preserved.** Sync updates content and occurrences but never discards user-assigned categories, tags or benchmark assignments.
16. **Self-hosted ready, not self-hosted first.** A persistence boundary (repository functions) and portable SQL keep a PostgreSQL / multi-user server practical later ([ADR-0009](../../decisions/0009-self-hosted-readiness.md)).
17. **Spec-driven and conservative.** Specs in `.ai/specs/` precede code; implementation status is stated precisely; unverified provider capabilities are marked "Assumption — requires validation".

## 7. Glossary

| Term | Definition |
|---|---|
| **Skill** | A packaged, reusable capability for an agent, typically a directory with a `SKILL.md` (YAML frontmatter + markdown body) and optional supporting files, e.g. `.agents/skills/<slug>/SKILL.md`. |
| **Instruction** | Repository- or user-level guidance loaded by an agent, e.g. `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`. |
| **Rule** | Scoped guidance with activation metadata, e.g. Cursor `.cursor/rules/*.mdc` (globs, `alwaysApply`). |
| **Artifact** | The logical identity of a skill, instruction or rule in DirectiveBench, independent of where it is stored. Has a type (skill/instruction/rule) and format (e.g. `skill-md`, `agents-md`, `cursor-rule`, `copilot-instructions`; full list in `packages/core/src/artifacts.ts`). |
| **Occurrence** | A concrete location of an artifact: repository + path, with the latest observed version, commit SHA and status. One artifact may have many occurrences. |
| **Version** | An immutable snapshot of an artifact's content identified by a content hash, with a sequential version number per artifact and a manifest of files. |
| **Suite** | A benchmark suite: a named set of cases with shared execution and scoring settings. Its definitions are versioned immutably (suite versions). |
| **Case** | One benchmark task: prompt, fixture, setup commands, allowed changes, assertions and optional verification overlay. |
| **Fixture** | The starting project directory for a case. Snapshotted at import into a content-addressed store `fixtures/<sha256>/`. |
| **Assertion** | A verification step evaluated on the workspace after the agent finishes (e.g. `command`, `file-exists`, `file-contains`, `changed-files`), with weight and `required` flag. |
| **Agent harness** | The program that drives a model to edit code: Claude Code, Codex CLI, Cursor Agent, the deterministic Mock Agent, or a future custom DirectiveBench harness. Integrated via an **agent adapter**. |
| **Model provider** | An API that serves models (Anthropic, OpenAI, DeepSeek, Z.AI GLM, Moonshot Kimi, OpenAI/Anthropic-compatible endpoints). Planned; contract in [SPEC-003](./system-architecture.md#6-extension-points). |
| **RED / GREEN** | RED = baseline run without the artifact; GREEN = candidate run with the exact artifact version installed. Same fixture, prompt, adapter, model, limits; fresh workspaces. |
| **Comparability** | Two results are comparable only if their comparability key — hash of suite version, fixture hashes, adapter id + version, model config, environment kind and limits — is equal. |

## 8. Related documents

- Requirements: [SPEC-002](./product-requirements.md)
- Architecture: [SPEC-003](./system-architecture.md), technology: [SPEC-004](./technology-stack.md)
- Domain and data: [SPEC-005](./domain-model.md), [SPEC-006](./database-schema.md)
- Security: [SPEC-007](./security-and-privacy.md)
- Roadmap: [SPEC-013](./implementation-roadmap.md)

## Implementation status

- **Implemented in bootstrap:** none of this document is code by itself. Identity items (package name `directivebench`, MIT `LICENSE`) are defined; the monorepo and CLI are being created concurrently — verify against `apps/cli/package.json` before marking anything implemented.
- **Partially (bootstrap scope):** Benchmark Engine with the deterministic Mock Agent and local-process environment; Quality Dashboard sections listed in [SPEC-116](../features/dashboard-and-navigation.md); Artifact Registry limited to importing bundled examples.
- **Not implemented:** repository registration/sync, discovery scanning, real agent execution, model providers, Docker sandbox, self-hosted server, teams features.
