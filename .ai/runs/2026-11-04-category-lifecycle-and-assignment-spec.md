---
title: Spec for issue 22 (E03-S01) categories create, rename, archive and assign
date: 2026-11-04
agent: Claude Code / claude-opus-5-5 (subagent, om-auto-write-spec + om-spec-writing --autonomous)
trigger: maintainer approved starting issue #22 (spec only)
status: completed
branch: spec/category-lifecycle-and-assignment
specs: [SPEC-124, SPEC-106, SPEC-101, SPEC-006, SPEC-014, SPEC-122]
---

# Run: spec for issue 22 (categories lifecycle and assignment)

## Objective

Write a design-only spec for issue #22 and open a spec PR (`Refs #22`) for the maintainer to
approve. No implementation.

## Plan

1. Check scope and dependencies (D08, #93, #17, #30).
2. `om-auto-write-spec 22`: claim, worktree in `.ai/tmp/`, `om-spec-writing --autonomous`,
   fresh-context review, screenshots and mockups, PR, assumptions comment, release, cleanup.

## Decisions

- Still in scope: D08 parked categories until S1 shipped; epic #93 (S1) is closed with every
  story done, dependencies #17 and #30 are closed, the issue's own note says "resumes after S1",
  and the maintainer approved the start.
- New SPEC-124 refines SPEC-106 for this story (A1); 22 autonomous defaults (§5a) and 9 UI
  decisions (§11.1) are left for the maintainer. No ADR (A22).

## Work performed

- Read issue #22, epic #12, #93, D07/D08/D09, the brief, backlog, SPEC-106, SPEC-101, the
  design system (`apps/web/design-system.md`, Storybook pages "What is missing", Form,
  Risky-action) and the category code (`schema.ts`, `catalog.ts`, `artifacts.ts`,
  `apps/web/app/categories`, `apps/web/app/artifacts`).
- Wrote `.ai/specs/2026-11-04-category-lifecycle-and-assignment.md` (SPEC-124) and its index
  entry.
- A fresh-context review agent found 2 high, 5 medium and 5 low issues. All were applied: bulk guard by id
  fingerprint instead of count, ids-only query for the bulk write, no TypeScript default for
  `name_key` plus the downgrade hazard, A3 reworded (`BEGIN IMMEDIATE` is the main guard),
  constraint errors remapped after rollback, one layout revalidation, bulk repository function
  moved to Phase 4, invalid filters refuse the bulk form, copy fixes, a concrete e2e hook for
  "list changed", A5 noted as narrowing G6.
- Screenshots of `/categories`, `/artifacts`, `/artifacts/[id]` from
  `.ai/scripts/test-env-up.sh` (mock demo data) and three static HTML mockups rendered with
  agent-browser, in `.ai/specs/assets/category-lifecycle-and-assignment/`.

## Verification

- Spec only; no code changed, so no quality gate run. Checked that the spec's UI copy has no en
  or em dash (`grep -P '\x{2013}|\x{2014}'`, only the H1 title uses the template's em dash).
- Not verified: any implementation behaviour; mockups are illustrative.

## Problems and deviations

- Branch `spec/<slug>` (the skill's convention, as in earlier spec PRs #136, #154) rather than
  `docs/issue-22-<slug>`.

## Lessons recorded

None: nothing non-obvious was learned beyond existing lessons.

## Follow-ups

- Maintainer: confirm or override A1 to A22 and UD-1 to UD-9, then set `approved`.
- After approval: `om-auto-implement-spec` phase by phase (§21).
- Cleanup done: test env stopped and its `/var/tmp` data removed; worktree removed after the PR.
