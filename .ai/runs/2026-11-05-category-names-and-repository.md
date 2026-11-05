---
title: Category names, migration 0005 and repository functions (SPEC-124 Phase 1, issue #22)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer approved implementing SPEC-124 Phase 1 only (issue #22)
status: in-progress
branch: feat/category-names-and-repository
specs: [SPEC-124, SPEC-106, SPEC-006, SPEC-014]
---

# Run: Category names, migration 0005 and repository functions (SPEC-124 Phase 1)

Source doc: .ai/specs/2026-11-04-category-lifecycle-and-assignment.md

## Objective

Implement SPEC-124 §21 Phase 1 only: name and slug helpers in core, the `name_key` column with a
partial unique index (migration `0005`), seeding that fills `name_key`, the category lifecycle
and single-assignment repository functions, `archived` on list and detail categories, and the
race-free `assignCategoriesBySlug`. No UI and no `apps/web` changes beyond what typecheck needs.
Phases 2 to 4 (pages, actions, bulk) ship in later PRs; issue #22 stays open (`Refs #22`).

## Plan

Goal: the database and core layers support creating, renaming, archiving and assigning
categories with database-enforced case-insensitive name uniqueness, so Phases 2 to 4 only add
web code.

Scope: `packages/core` (categories), `packages/database` (schema, migration, `catalog.ts`,
`artifacts.ts`, tests), SPEC-006, SPEC-106 FR-106-03, SPEC-124 §20. Runner code does not change:
`assignCategoriesBySlug` lives in `packages/database` and keeps its signature.

Non-goals: Zod schemas, Server Actions and pages (Phases 2 and 3); `listArtifactIds`,
`setCategoryForListedArtifacts`, `MAX_BULK_CATEGORY_ARTIFACTS` (Phase 4); web
`MAX_SLUG_PARAM_LENGTH` from core (Phase 2); `packages/runner/src/runner.ts`,
`packages/runner/src/hosted-*.ts` and `repository-registration.ts` (other agents).

Risks: drizzle-kit may generate a table rebuild for a NOT NULL column (hand-edit to the spec's
`ALTER TABLE ADD … DEFAULT ''`); the unique-index backstop cannot be reached through the
in-transaction check, so tests force it through an intercepting Drizzle proxy over the same
connection; the web app types change when categories gain `archived`.

## Progress

PR: #190

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Names, migration and repository functions (no UI)

- [x] 1.1 Core name and slug helpers and limits — 89eec59
- [x] 1.2 Schema nameKey, partial index and migration 0005 with backfill test — 1154fc3
- [x] 1.3 Seeding writes name_key and skips clashes — 1154fc3
- [x] 1.4 createCategory, updateCategory, setCategoryArchived, getCategoryBySlug — f0aeff4
- [x] 1.5 assignArtifactCategory, unassignArtifactCategory, archived on list and detail — c9f10b5
- [x] 1.6 assignCategoriesBySlug as one conditional statement per slug with race test — c9f10b5
- [x] 1.7 Update SPEC-006, SPEC-106 FR-106-03 and SPEC-124 status — 25c7848

## Decisions

- The config `baseBranch` is `auto`; it resolves to the default branch `main`.
- Name length, control characters and description length are not re-checked in the repository
  functions: SPEC-124 §8.3 puts them in the web Zod schemas (Phase 2), as for tags and notes
  today. The repository normalises the name again (`normalizeCategoryName`) so the stored name
  and its key always agree.
- `slugify`'s character logic moved to an internal `packages/core/src/slug.ts`
  (`slugCharacters`, not exported from the package), so `categorySlug` can tell "nothing kept"
  from the fallback `item` without a second rule. `slugify` behaves exactly as before.
- `isUniqueViolation` reads SQLite's extended code 2067 from the Drizzle error's `cause`
  (`DrizzleQueryError` → `node:sqlite` error with `errcode`), measured on this toolchain.
- The index backstop cannot be reached through the in-transaction checks, so tests force it with
  `test/support/intercept.ts`: a Drizzle proxy on the same connection that hides one clash-check
  result (the insert then hits the index), or runs SQL right before a statement (the archive
  race). Unexplainable violations are produced with triggers whose clashing row rolls back.
- `assignCategoriesBySlug` keeps its signature and contract; `assigned` now follows the input
  order with each slug once (before: database order), and a missing artifact no longer throws a
  foreign-key error (the conditional insert writes nothing). The only caller (example import)
  always passes an existing artifact and ignores the order.
- Assigned categories are ordered active first, then by name; with no archived assignment (all
  databases today, since nothing can archive yet) the order is unchanged, so the web pages render
  as before.

## Work performed

1. Core helpers and limits with tests (89eec59).
2. Schema `nameKey` + partial index; `drizzle-kit generate --name category_name_key`, then the
   SQL hand-edited for `DEFAULT ''` and the backfill (§8.1); migration test from a `0004`
   database with rollback rehearsal; seeding writes `name_key`; clash test (1154fc3).
3. Lifecycle functions with the unique-index backstop and generated slugs (f0aeff4).
4. Single assign/remove, `archived` on assigned categories, race-free `assignCategoriesBySlug`
   (c9f10b5).
5. SPEC-006 §3.1 and status, SPEC-106 FR-106-03 and §20, SPEC-124 §20 (25c7848).

## Verification

| Check | Result |
| --- | --- |
| Red: archive-race test against the old `assignCategoriesBySlug` (select, then insert) | fails: `assigned: ['security']`, expected `unknown: ['security']`; passes with the conditional insert |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 7/7 tasks, 100% coverage everywhere (core 292, database 215, runner 235, web 479, cli 160, benchmark-engine 518, agent-adapters 364) |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |
| Upgrade: `init` with the `main` build (migrations 0000 to 0004), one category renamed and archived by hand, then `init` with this build | "1 migration(s) applied"; 17 rows, none with `name_key = ''`, `name_key` = lower name (archived row included), the partial index exists and refuses a raw second active `devops` |
| `demo` with this build on the upgraded data directory | completes (mock agent, verdict improved); the example import assigned `security` and `code-quality` through the conditional insert |

Not verified: anything in `apps/web` (no page uses the new functions yet); NFR-124-01 timing
(Phase 4, bulk); `pnpm test:e2e` and `pnpm test:storybook` were not run because no UI changed.

## Problems and deviations

None against the spec. The generated-slug check "opens their `[slug]` page" (§15) is covered
in Phase 1 only as "matches the web slug pattern and `getCategoryBySlug` finds it"; the page is
Phase 2.

## Lessons recorded

None yet.

## Follow-ups

- Phase 2: schemas, actions and pages; `MAX_SLUG_PARAM_LENGTH` from `CATEGORY_SLUG_MAX_LENGTH`;
  archived chips and the archived filter option; SPEC-101 FR-101-10.
- Phases 3 and 4 as in SPEC-124 §21.
