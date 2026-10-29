---
title: SPEC-123 Phase 1, capture and storage of agent run output files
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, Phase 1 approved on 2026-10-29), om-auto-implement-spec
status: in-progress
branch: feat/agent-run-output-files-capture
specs: [SPEC-123, SPEC-006, SPEC-014, SPEC-118]
---

# Run: SPEC-123 Phase 1, capture and storage of agent run output files

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** §21 "Phase 1: Capture and storage" of SPEC-123 (issue #152): the engine keeps
the files each agent run added or modified, bounded, redacted, and the runner stores them in the
local database with the agent run. No UI, no CLI export, no blind review, no syntax highlighting
(Phases 2 to 5 and 3a).

Acceptance criteria used (Phase 1 slice): FR-123-01 to FR-123-11, FR-123-60, §8.1 (migration
`0003` only), §8.2, §8.3 (`insertAgentRun`, `listAgentRunFiles`, `getAgentRunFile`), the Phase 1
tests of §15, and the engine/database side of AC-2, AC-3, AC-4, AC-8 (agent-run files only),
AC-9, AC-10 and AC-11. The UI side of AC-1 to AC-4 and AC-11 is Phase 3.

## Plan

Goal: every agent run that reached the agent stage keeps its changed files' content within the
named limits, redacted fail-closed, in `agent_run_files`, inserted in the same transaction as
the agent run.

Non-goals: pages, components, export command, blind-review tables (`0004`), Shiki, changes to
scoring, verdicts or trace redaction.

Risks: redaction gaps at the cut (mitigated by the stateful whole-file key-marker scan and the
regression tests of FR-123-07); memory retention across runs (FR-123-10, tested with a `WeakRef`
and `gc`); breaking existing `toEqual` assertions on records (handled per test).

### Phase 1: Storage

1. Migration `0003_agent_run_output_files.sql`, Drizzle schema, migration up/down test pinned to
   its journal prefix, cascade test.
2. Repository: `insertAgentRun` with files and the kept flag and reason in one transaction;
   `listAgentRunFiles`, `getAgentRunFile`.

### Phase 2: Redaction contract

1. Core `findSecretRanges(text, knownSecrets, { textEnd })`, `TextRange`, pattern minimum
   lengths; tests for every rule with both `textEnd` values.
2. `AgentAdapter.findOutputSecrets` in the contract, the mock agent and the Claude Code adapter;
   corpus test of FR-123-60.

### Phase 3: Engine capture

1. `benchmark-engine/src/output-files.ts`: bounded read through the pinned workspace with size
   and sha256 check, whole-file stateful key-marker scan, range union, cut, limits, order,
   UTF-8/NUL check, artifact-path exclusion, failure path; unit tests incl. the private-key
   regressions.
2. Wire into `executeAgentRun` (before the overlay; `completed` reuses the measurement manifest,
   `agent-error`/`timeout` build their own inside the capture's error handling), keep it on every
   later return path, deliver with `onAgentRun(record, capture)`, release it afterwards;
   status-path and memory tests.

### Phase 4: Runner and verification

1. Runner `persistAgentRun` stores the capture; runner tests.
2. SPEC-006 table list, SPEC-123 §20 status, full quality gate, real run with the built CLI
   (`directivebench demo`) checking `agent_run_files` rows and unchanged scores (AC-9).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Storage

- [ ] 1.1 Migration 0003, schema, migration and cascade tests
- [ ] 1.2 Repository functions for agent run files

### Phase 2: Redaction contract

- [ ] 2.1 Core findSecretRanges
- [ ] 2.2 Adapter findOutputSecrets for mock and Claude Code

### Phase 3: Engine capture

- [ ] 3.1 captureOutputFiles with bounded read, scan, cut and limits
- [ ] 3.2 Wire capture into the orchestrator and onAgentRun

### Phase 4: Runner and verification

- [ ] 4.1 Runner persists the capture
- [ ] 4.2 Specs, quality gate and real-app verification

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
