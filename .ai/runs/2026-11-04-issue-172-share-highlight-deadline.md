---
title: Share SYNTAX_HIGHLIGHT_DEADLINE_MS with the real-capture e2e spec
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #172 (om-auto-fix-issue), maintainer request
status: completed
branch: chore/issue-172-share-highlight-deadline
specs: [SPEC-123]
---

# Run: Share SYNTAX_HIGHLIGHT_DEADLINE_MS with the real-capture e2e spec

## Objective

Issue #172: `apps/web/e2e/real-capture.spec.ts` hard-coded `HIGHLIGHT_DEADLINE_MS = 2_000`
because it cannot import the server-only `apps/web/lib/syntax-highlight.ts`. Acceptance
criteria: one definition of the deadline, imported by the e2e spec; gate green with 100%
coverage.

## Plan

Move the constant to `apps/web/lib/syntax-highlight-common.ts`, which already holds the other
limits, has no imports and no `server-only`, re-export it from `syntax-highlight.ts` so every
existing importer and SPEC-123's wording stay valid, and import it in the e2e spec.

## Decisions

- Reused `syntax-highlight-common.ts` instead of the new `syntax-highlight-limits.ts` the issue
  suggested as an example: the common module is already the plain, importable home of the
  highlighting limits, and a second limits module would split them.
- No spec change: SPEC-123 names the constant, not its module, and `syntax-highlight.ts` still
  exports it.

## Work performed

1. Verified in repo: the hard-coded copy was still at `real-capture.spec.ts:57`; no open PR.
2. Moved the constant and its doc comment to `syntax-highlight-common.ts`, imported and
   re-exported it in `syntax-highlight.ts`, and imported it in the e2e spec (local copy
   removed).
3. Added a unit test in `apps/web/test/syntax-highlight-worker.test.ts` that the server
   module's export is the common module's constant, so a later redefinition with another
   value fails.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass (7/7 typecheck tasks; `apps/web/tsconfig.json` includes `e2e/`) |
| `pnpm test` | pass, 100% coverage in every package (web 478 tests) |
| `pnpm build && pnpm verify:pack` | pass, "Packaging verification passed" |
| `TMPDIR=/var/tmp/db-issue-172 pnpm test:e2e` | 109 passed, including `real-capture` |

Not verified: no red-first run, since this is a refactor with no behaviour change; the value
stays 2,000 ms. No browser QA: no UI change.

Review: `om-auto-review-pr 180 --autofix` (engine `om-code-review`) approved head `4418244`,
posted as COMMENT, with two nits kept (the worker test has two imports from the common module;
the new test guards against diverging values, not against a second definition with the same
value).

## Problems and deviations

None.

## Lessons recorded

None (nothing non-obvious learned).

## Follow-ups

None.
