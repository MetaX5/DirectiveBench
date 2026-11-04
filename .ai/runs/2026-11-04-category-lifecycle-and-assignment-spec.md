---
title: Spec for issue 22 (E03-S01) categories create, rename, archive and assign
date: 2026-11-04
agent: Claude Code / claude-opus-5-5 (subagent, om-auto-write-spec + om-spec-writing --autonomous)
trigger: maintainer approved starting issue #22 (spec only)
status: in-progress
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

## Review and maintainer decisions (round 2, 2026-11-04)

- Codex adversarial review (plugin `codex` 1.0.6, `adversarial-review --wait --base origin/main`
  with a spec-focused brief) on 0da1938: **needs-attention**, 2 medium findings, both triaged
  as real against the code and applied:
  1. `assignCategoriesBySlug` (example import) selects active categories, then inserts in
     separate statements outside a transaction (`packages/database/src/repositories/artifacts.ts`,
     `packages/runner/src/import.ts`), so an archive from the web process could slip between
     them. Now one conditional `INSERT … SELECT … WHERE archived_at IS NULL` per slug, a Phase 1
     step with an interleaving regression test (§8.2, §15, §21).
  2. Phase 2 shipped Archive while archived chips and the archived filter option waited for
     Phase 3; `/artifacts` would then show "All" in the dropdown while filtering by an archived
     slug (`apps/web/app/artifacts/page.tsx` drops archived options). Moved archived display,
     the archived filter option and `MAX_SLUG_PARAM_LENGTH` to Phase 2; Phase 3 is now
     "Assignment on the artifact page".
- Maintainer (Mateusz) accepted A1 to A22 and UD-1 to UD-9 as written, except:
  - **A5:** names with no Latin letter or digit are accepted with a generated slug
    `category-N` (first free N above the largest `category-<digits>` slug, inside
    `createCategory`'s `withTransaction`, slug unique index as backstop, BigInt for long
    numbers). Edits: G6, A5, FR-124-02, FR-124-04, §8.2, §8.3, §13 (error row removed),
    §14 ("Category 7", "日本語 2"), §15, AC-1, §19.
  - **UD-5:** Archive and both bulk actions confirm with the count through the unchanged
    Risky-action inline pattern (`destructive` confirming button); Unarchive, single assign
    and remove need none. Recorded as a maintainer override of the pattern's "When not to
    use"; the one-line additions to `risky-action.mdx` and `design-system.md` are Phase 2
    work. Edits: FR-124-08, FR-124-13, §11 copy, §11.1, §14, §15, AC-4, AC-8, Phases 2 and 4.
  - Counts use one formatter, `toLocaleString('en-US')` ("1,240"), stated in §13.
  - A9 (no hard delete) kept. Spec status stays `draft`.
- Lessons: none. These are decisions on offered defaults, not corrections of a mistake.

## Follow-ups

- Maintainer: approve the spec (set `approved`).
- After approval: `om-auto-implement-spec` phase by phase (§21).
- Cleanup done: test env stopped and its `/var/tmp` data removed; worktree removed after the PR.
