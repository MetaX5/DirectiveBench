---
title: SPEC-123 Phase 2, CLI export of agent run output files
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, Phases 2 and 3 approved on 2026-10-29), om-auto-implement-spec
status: in-progress
branch: feat/agent-run-output-files-export
specs: [SPEC-123, SPEC-014, SPEC-118]
---

# Run: SPEC-123 Phase 2, CLI export of agent run output files

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** §21 "Phase 2: CLI export" of SPEC-123 (issue #152):
`directivebench benchmark export <run-id> --out <dir> [--json]` (§6.4, FR-123-40 to FR-123-43,
AC-6). Phase 1 (capture and storage) is merged in #157. No web UI (Phase 3 runs in parallel in
another worktree), no compare, no blind review, no syntax highlighting.

Acceptance criteria used: FR-123-40 to FR-123-43, the §13 export rows, the §15 `apps/cli` unit
tests (layout, manifest, unsafe paths, non-empty target, read-only database refusal, the claim
race of FR-123-41) and AC-6.

## Plan

Goal: a user exports a run's kept, redacted files and a manifest into a fresh directory, without
any stored (untrusted) path reaching the file system unvalidated and without ever overwriting or
following anything.

Non-goals: `apps/web`, blind review (`0004` does not exist yet, so FR-123-52a's export warning
has nothing to check; it is a Phase 5 follow-up), `--blind` export (§19), changes to the
repository layer beyond reading through `getBenchmarkRunDetail`, `listAgentRunFiles` and
`getAgentRunFile`.

Risks: a hostile stored path escaping `<dir>` (mitigated by segment validation plus
`resolveInside`, exclusive create, and directories created one segment at a time inside the
claimed `files/`); a race with a concurrent writer into `<dir>` (claim with `wx` and a
non-recursive `mkdir`); case-insensitive collisions (EEXIST becomes `path-collision`).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Export command

- [ ] 1.1 `benchmark export` command: target claim, path validation, file writes, manifest, summary and `--json`
- [ ] 1.2 Unit tests to 100%: layout, manifest, unsafe paths, collisions, refusals, claim race, runtime error

### Phase 2: Verification and docs

- [ ] 2.1 Full gate and a real export of a `directivebench demo` run with the built CLI
- [ ] 2.2 SPEC-123 §20 status for verified behaviour, run log, lessons

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
