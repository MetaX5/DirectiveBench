---
title: Reject U+0000 in web input and benchmark definitions before the database guard
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #273 (maintainer approved taking it now)
status: completed
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
4. Codex round 1: a YAML alias cycle in `agentOptions` overflowed the recursive walk; fixed by
   tracking ancestors. Round 2: 5,000 nested JSON objects still overflowed; the walk now keeps an
   explicit stack, checks cycles along the parent chain and reports nesting deeper than
   `MAX_DEFINITION_DEPTH` (100) as an issue (FR-108-17). Round 3: approve.

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

| Command | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test` (Node 24.21, 100% coverage, after merging main `1b53490`) | pass: core 353, agent-adapters 384 (+2 skipped), database 385, benchmark-engine 524, runner 313, cli 210, web 655 |
| `pnpm build`, `pnpm verify:pack` | pass |
| `pnpm test:e2e` (port 4402) | 205 passed on the final head after merging main (Chromium 1255); also 205 passed twice before (Chromium 1254 through symlinks) |
| `pnpm test:storybook` | 342 tests passed (after merging main too) |

Red first (new tests with the source unchanged):
- `apps/web/test/actions.test.ts`: 4 failed, each with `Failed query ... Caused by: NulInTextError`
  (blind review note, notes, a hidden artifact id, a repository id); the tag/category and the
  repository path tests passed already (existing rules).
- `apps/web/test/repositories.test.ts`: 2 failed (`jobIdParam is not a function`).
- `packages/benchmark-engine/test/definition.test.ts`: 2 failed (U+0000 accepted); the cycle test
  failed with `RangeError: Maximum call stack size exceeded`, the deep nesting test likewise
  against the round-1 walk.
- e2e against the pre-fix build: the notes test failed (no field error); `curl` on the pre-fix
  server: `/repositories?registration=%00` and `?scan=job%00` returned 500 with
  `NulInTextError` in the log, `/results/%00` and `/benchmarks/x%00` 404, `/artifacts?q=%00` 200.

Real app (built CLI, `demo` data, port 4402):
- A crafted no-JS multipart POST of the Notes form with `notes=before\0after` returned 200 with
  the field error "Notes cannot contain a NUL character (U+0000). Remove it." in the rendered
  state; the stored notes stayed `null`; the same POST with valid text saved it (control).
- `/repositories?registration=job_%00`, `?scan=%00`, `?branchChange=x%00`: 200; no
  `NulInTextError` in the server log.
- `directivebench benchmark run nulsuite --artifact validate-external-input` with
  `name: "Suite\0hidden"` (no NUL byte in the file; a fake `claude` that refuses everything
  first on PATH): exit 2, `- name: must not contain a NUL character (U+0000)`, no suite stored.
- Browser QA agent (Claude in Chrome): notes and blind review note errors, keyboard only, both
  themes (error contrast 9.34:1 dark, 8.36:1 light), 320px (no horizontal scroll), the three
  Repositories URLs and the console: all pass, no findings.

Not verified:
- Node 22.16.0 for these tests (no SQL changed; the `oldest-node` CI job runs the engine tests).
- Windows and macOS.

## Problems and deviations

- Playwright in `main` wants Chromium revision 1255. Before it was installed, the first two e2e
  runs used `PLAYWRIGHT_BROWSERS_PATH` pointing at a temporary directory of symlinks to the 1254
  builds (removed afterwards); the final run used the installed 1255.
- `main` moved (PR #276, #272) during the run; merged `origin/main` (clean, `.ai/lessons.md`
  auto-merged) and reran the whole gate.

## Lessons recorded

- Updated [node:sqlite on Node 22 truncates TEXT at the first NUL](../lessons/2026-11-19-node-22-sqlite-truncates-text-at-nul.md):
  the guard fires on lookups; Next.js 404s `%00` path segments; prove a suspected path first.

## Follow-ups

- `benchmark_runs.agent_version` comes from the agent's `--version` output and is written as
  plain text; it is agent output, not user input, and was out of scope here.
- `om-auto-review-pr 279`: COMMENT review, no blockers or majors; minor 1 (stored suite versions
  are re-validated) addressed in FR-108-17; two nits left.
