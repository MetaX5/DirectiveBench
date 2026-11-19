---
title: Reject U+0000 in web input and benchmark definitions before the database guard
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #273 (maintainer approved taking it now)
status: in-progress
branch: fix/issue-273-reject-nul-input
specs: [SPEC-006, SPEC-101, SPEC-104, SPEC-108, SPEC-123, SPEC-124, SPEC-014]
---

# Run: Reject U+0000 in web input and benchmark definitions before the database guard

## Objective

Issue #273: since #265 the database client refuses any string parameter holding U+0000
(`NulInTextError`). No user or benchmark-definition input may reach that guard; each must get a
validation message (a field error in the web app, a definition issue naming the field).

## Plan

1. Inventory every web input that reaches a repository function (server action form fields,
   URL path segments and query parameters) and every definition string that reaches a TEXT
   column or a process argument.
2. Red-first unit tests per schema, then the refinements.
3. Specs (SPEC-006 §1 Text, SPEC-108, SPEC-101, SPEC-104, SPEC-123), e2e, gate, real-app proof,
   QA, Codex review, draft PR.

Re-plan: the first version also guarded URL path segments in `proxy.ts` (400 for `%00`) and the
artifact list search `q`. A run of the pre-fix build showed both were never broken: Next.js
answers a path segment holding `%00` with 404 before a page runs, and `q` is matched in
JavaScript, not passed to SQL. Both changes were reverted to keep the change to what fails.

## Decisions

- The guard fires on lookups too (it checks every statement), so hidden ids are covered, not
  only stored text. One shared `idSchema` and `hasNoNul` in `apps/web/lib/form-input.ts` replace
  three identical `z.string().min(1)` id schemas and four inline ones.
- User text gets a field message: notes ("Notes cannot contain a NUL character (U+0000).
  Remove it.") and the blind review note ("A note cannot ..."). Tags and category name and
  description already refuse every control character (`\p{Cc}` includes U+0000); tests now pin
  that. A hidden id gets the form's existing general refusal.
- `/repositories` reads three job ids from its query (`registration`, `scan`, `branchChange`);
  `jobIdParam` ignores a missing, repeated or NUL-holding one, as an unknown id is ignored.
- Benchmark definitions: one walk in the schema's top-level `superRefine` refuses U+0000 in every
  string value and object key (FR-108-17), because suite name/description reach TEXT columns and
  the rest reaches process arguments (Node refuses NUL in argv) or files. A key's issue names its
  object, so the path never repeats the NUL. The two characters `\0` (a regex escape) stay valid.

## Work performed

1. Inventory (below), red-first tests in `apps/web/test/actions.test.ts`,
   `apps/web/test/repositories.test.ts` and `packages/benchmark-engine/test/definition.test.ts`.
2. `fix(web): refuse U+0000 in form fields, ids and URLs before the database` (refinements,
   `jobIdParam`, definition walk); the proxy and `q` parts were later reverted (see Plan).
3. e2e in `apps/web/e2e/artifact-metadata.spec.ts`; specs; lesson update.

Inventory of string inputs that reach a repository function:

| Input | Before | Now |
| --- | --- | --- |
| Artifact notes | `NulInTextError` | field message |
| Blind review note | `NulInTextError` | field message |
| Tag, category name/description | already refused (control characters) | unchanged, tests added |
| Repository path, confirmed location, branch, URL (name derives from these) | already refused | unchanged, test added for the path |
| Hidden ids: artifact, suite, category, benchmark run, pair, review, repository (scan, remove), suite version, job (cancel), bulk category | `NulInTextError` (lookups) | general refusal / ZodError like any invalid id |
| `/repositories?registration=`, `?scan=`, `?branchChange=` | HTTP 500 (`NulInTextError`) | ignored, page renders |
| Route segments (`/results/%00`, `/benchmarks/%00`, ...) | 404 from Next.js | unchanged, e2e pins it |
| `/artifacts?q=` and bulk-form `q` | matched in JavaScript, no DB parameter | unchanged |
| Benchmark definition strings (suite name/description and all others) | Drizzle query error at import (after the CLI plan and confirmation) | definition issue per field |

## Verification

(see the PR description for the final table; filled in below)

## Problems and deviations

- Playwright in `main` now wants Chromium revision 1255; only 1254 is installed. The e2e runs used
  `PLAYWRIGHT_BROWSERS_PATH` pointing at a temporary directory of symlinks to the 1254 builds
  (removed afterwards). CI installs its own browser.

## Lessons recorded

- Updated [node:sqlite on Node 22 truncates TEXT at the first NUL](../lessons/2026-11-19-node-22-sqlite-truncates-text-at-nul.md):
  the guard fires on lookups; Next.js 404s `%00` path segments; prove a suspected path first.

## Follow-ups
