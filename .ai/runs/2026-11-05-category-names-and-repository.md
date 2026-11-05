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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Names, migration and repository functions (no UI)

- [ ] 1.1 Core name and slug helpers and limits
- [ ] 1.2 Schema nameKey, partial index and migration 0005 with backfill test
- [ ] 1.3 Seeding writes name_key and skips clashes
- [ ] 1.4 createCategory, updateCategory, setCategoryArchived, getCategoryBySlug
- [ ] 1.5 assignArtifactCategory, unassignArtifactCategory, archived on list and detail
- [ ] 1.6 assignCategoriesBySlug as one conditional statement per slug with race test
- [ ] 1.7 Update SPEC-006, SPEC-106 FR-106-03 and SPEC-124 status

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
