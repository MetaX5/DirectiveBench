---
title: Write the S1 spec — benchmark own skills with Claude Code against registry artifacts
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: user request (om-auto-write-spec, brief .ai/specs/briefs/2026-10-22-benchmark-own-skills-s1.md)
status: completed
branch: spec/benchmark-own-skills-s1
specs: [SPEC-118, SPEC-203, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-113, SPEC-009, SPEC-013]
---

# Run: Write the S1 spec — benchmark own skills with Claude Code against registry artifacts

## Objective

Turn the S1 brief into a draft feature spec on a design-only PR, update the existing specs it
changes, record product decision D08 in the product brief, and record the human correction about
generic design as a lesson.

## Plan

1. Isolated worktree on `spec/benchmark-own-skills-s1` from `origin/main`; copy the brief in.
2. Read AGENTS.md, the specs index, lessons, the product brief and SPEC-203/107/108/110–113/013.
3. Write SPEC-118 (next free feature id) with resolved assumptions for what the brief leaves open.
4. Edit the affected sections of existing specs for consistency; add D08 and its decision file.
5. Lesson + index entry; scope-cohesion review by a fresh-context subagent; format check.
6. Commit, push, open the PR with labels and the assumptions comment.

## Decisions

- Thirteen autonomous defaults for what the brief left open, listed in SPEC-118 "Resolved
  assumptions"; Q5 (`--approve-commands` as a CLI approval channel) is marked
  `⚠ NEEDS HUMAN CONFIRMATION` because roadmap M3 says approval happens in the UI, so the PR
  stays draft.
- The brief's choices that change approved-looking defaults were applied as the maintainer's
  decisions: SPEC-203 §7 `authMode` default becomes `subscription` (was "user must choose").
- The design-genericity correction is a rule for all future work, so it went into `AGENTS.md` §7
  as well as a lesson.
- `.ai/specs/briefs/` was added to the specs README layout (the brief must be committed with the
  spec); `AGENTS.md` §1's directory list does not name it yet (follow-up).
- The worktree lives under the primary checkout's `.ai/tmp/` (skill convention; a cross-device
  move to the scratchpad failed) and is removed at the end.

## Work performed

- Copied the brief into the worktree; wrote SPEC-118
  (`.ai/specs/2026-10-22-benchmark-own-skills-s1.md`) and indexed it.
- Updated sections of SPEC-203, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-113,
  SPEC-114, SPEC-009 and SPEC-013 (listed in SPEC-118 §17); all stay `draft`.
- Product brief: D08 added (supersedes D01), D07 answered early, A02/A04 results, Scope Now/Later,
  Decision summary, Definition of Ready addendum; decision file D08; D01/D07 statuses.
- Lesson `2026-10-22-design-generic-not-for-the-example.md`, index entry, AGENTS.md §7 rule.
- A fresh-context subagent reviewed SPEC-118 (scope cohesion, consistency, security, speculative
  surface). Applied: normalised flags hash and `reportedModels` drift as a warning; FR-118-06
  (fixture settings that run code or reroute auth/billing) and FR-118-07 (edits confined to the
  workspace); FR-118-15 (stop on auth/quota errors); FR-118-39 (nothing persisted before the
  final transaction; approval recorded only after confirmation); `--max-budget-usd` only with an
  API key; slug confinement for `init`; ACs 14–20; trimmed unrequested assertion options
  (`level`, `exact`, `mode: any`, `match: all`, `table.headerPattern`, `row.column`) and
  `init --dir/--version`; split the CLI and UI into separate phases and moved the web guard into
  phase 2; SPEC-115 change scheduled in phase 2.

## Verification

- `prettier --check .` (repository config; Markdown and `.ai/` are prettier-ignored): passed.
- Relative links in every changed or new document resolve: 0 broken.
- `pnpm lint` / typecheck / tests: not run — docs-only change, no file in their scope changed.
- Not verified: anything about Claude Code behaviour beyond what SPEC-203 already records; the
  `system/init` auth-source field is marked as an assumption in FR-118-06.

## Problems and deviations

- Mockups and current-app screenshots were skipped: no `.ai/qa/test-env.json` descriptor and
  `agent-browser` is not installed.

## Lessons recorded

- [2026-10-22-design-generic-not-for-the-example.md](../lessons/2026-10-22-design-generic-not-for-the-example.md)

## Follow-ups

- Maintainer: confirm or replace SPEC-118 Q5 (CLI command approval).
- Maintainer: the terms review of SPEC-203 §3.2 before a release with subscription as default.
- Tracker: close or annotate #30 (D07 answered) and #26 (A04 skipped), and park #20/#21/#22.
- Decide whether `AGENTS.md` §1 should list `specs/briefs/`.
- Next: `om-auto-implement-spec .ai/specs/2026-10-22-benchmark-own-skills-s1.md` phase 1.
