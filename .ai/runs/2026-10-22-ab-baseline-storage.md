---
title: A/B baseline storage, agent-profile comparability, CLI-owned jobs and the web guard (SPEC-118 Phase 2)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 95 (E06-S02), feature route → om-auto-implement-spec → om-auto-create-pr
status: in-progress
branch: feat/issue-95-ab-baseline
specs: [SPEC-118, SPEC-107, SPEC-111, SPEC-112, SPEC-114, SPEC-115]
---

# Run: A/B baseline storage and guards (SPEC-118 Phase 2, issue #95)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Objective

Implement SPEC-118 §21 Phase 2 for issue #95 (E06-S02), on the mock agent, without any real
adapter: a benchmark run may use another version of the same artifact as its baseline
(`RunBenchmarkInput.baselineArtifact`, FR-118-10…13), the baseline is stored on the run
(`benchmark_runs.baseline_artifact_version_id`, §8.1), the comparability key gains
`agentProfile` only when one is reported (§8.3, AC-5), `config.json` carries a generated
`installationId` (SPEC-115), a job can be created already acquired by its runner and run
in-process (FR-118-34, AC-9), and the web app refuses to enqueue a non-mock suite (FR-118-05/53,
AC-19 first half).

Acceptance criteria used: the six Given/When/Then criteria of issue #95 (AC-3, AC-5, AC-9,
AC-19 first half, FR-118-12/13, §8.1 payload).

Non-goals: the Claude Code adapter (Phase 3), the `benchmark` CLI commands (Phase 4), the
read-only results UI (Phase 5), the assertion registry and document assertions (issue #94,
Phase 1, in flight on another branch), three-way runs, `hostId` export/import.

## Plan

Goal: the mock path gains an optional A/B baseline end to end (engine → job → runner → stored
run), CLI-owned jobs that `serve` can never acquire, and a web refusal of non-mock suites — with
every existing mock comparability key byte-identical.

Risks: the migration (additive, nullable, must apply on existing databases); the acquired-job
path (must be one statement, never visible as `pending`); concurrency between a polling runner
and an acquired job; a comparability-key change that would split existing history (guarded by
a pinned-key test and a before/after `demo` comparison).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Engine

- [ ] 1.1 Shared baseline rule in core, `baselineArtifact` in `assertRunnable` and `runBenchmark` (baseline variant installs the baseline version)
- [ ] 1.2 `AgentProfile` in `EnvironmentMetadata` and the comparability key; mock key byte-identical

### Phase 2: Database and configuration

- [ ] 2.1 Migration `baseline_artifact_version_id` + schema + `createBenchmarkRun`
- [ ] 2.2 Job payload schema (baseline, auth mode, budget), reference checks, `createAcquiredBenchmarkJob`
- [ ] 2.3 `installationId` in `config.json` and the SPEC-115 update

### Phase 3: Runner

- [ ] 3.1 Runner loads and re-validates the baseline and stores it on the run
- [ ] 3.2 `LocalRunner.runAcquiredJob` and the concurrent-runner test

### Phase 4: Web guard

- [ ] 4.1 Server action refuses non-mock suites; benchmark page shows "Run from the CLI"; unit and Playwright tests

### Phase 5: Verification and documentation

- [ ] 5.1 Quality gate, `demo` before/after key comparison, SPEC-118 §20 and related spec statuses, lessons

## Decisions

## Work performed

## Verification

Before any change, `directivebench demo` on `origin/main` (c7576e6) stored comparability key
`8212a3ebe5818fbf2413bfd7671874710a362f4f5fde0b20c53f77174a8e0f9f` for the bundled mock example.

## Problems and deviations

## Lessons recorded

## Follow-ups
