---
title: Mock badge on the suites list, mock-agent doc comment, table filler padding (issue #74)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #74, decisions D1 to D7 and Q3 approved by the maintainer on 2026-11-04
status: in-progress
branch: feat/issue-74-mock-badge-suites-list
specs: [SPEC-101, SPEC-107, SPEC-116]
---

# Run: Mock badge on the suites list, mock-agent doc comment, table filler padding (issue #74)

## Objective

Three review nits from PRs #71 and #72. Acceptance (issue #74): the suites list shows the mock
badge for a mock suite (Playwright assertion); the `isMockAgent()` doc comment and the Markdown
table filler cell are updated; the existing tests still pass.

## Plan

Chain `om-auto-fix-issue 74`: `om-verify-in-repo` → `om-root-cause` → `om-fix` → `om-open-pr
--handoff om-auto-review-pr` → `om-auto-review-pr --autofix` → `om-auto-qa-pr`, plus the Codex
adversarial review (AGENTS.md §2 step 14). The issue is labelled `enhancement` but is covered by
SPEC-116 FR-116-14, so it took the bug-chain shape on a `feat/` branch without a new spec.

## Decisions

Approved by the maintainer on 2026-11-04 (not re-opened):

- D1/D2: the Agent column of `/benchmarks` renders `MockBadge` when `isMockAgent()` holds,
  otherwise the agent id in a `font-mono text-ui` span, exactly as `/results` does. Agent
  column only; the Last run cell is unchanged.
- D3: the existing badge text and `title`, unchanged.
- D4: at 320px the badge wraps inside its cell like on `/results` (no `min-w-max`).
- D5: no new tokens; contrast stays covered by `e2e/text-contrast.spec.ts` on `/benchmarks`.
- D6: the broadened `isMockAgent()` doc comment (SPEC-101 FR-101-14 and SPEC-116 FR-116-14
  checked and correct).
- D7: the filler cell gets `px-2 py-1 align-top`, the classes of its sibling cells.
- Q3: SPEC-101 FR-101-14 and SPEC-107 FR-107-13 quote the shipped colon wording; no other
  dash cleanup (issue #123).
- The config `baseBranch` is `auto`; it resolves to the default branch `main`.

## Work performed

1. Red first: `apps/web/e2e/management.spec.ts` asserts the badge text in the suite row
   (replacing `toContainText('mock')`); `apps/web/e2e/registry.spec.ts` asserts the filler
   cell's computed padding equals its sibling's, is non-zero, and is top-aligned.
2. Fix in `apps/web/app/benchmarks/page.tsx`, `apps/web/lib/mock-agent.ts` and
   `apps/web/components/artifacts/markdown.tsx`.
3. Docs: `apps/web/stories/product/mock-badge.mdx` §2 and §9, SPEC-101 FR-101-14, SPEC-107
   FR-107-13 wording, SPEC-116 implementation status.

## Verification

| Check | Result |
| --- | --- |
| Red: `playwright test e2e/management.spec.ts e2e/registry.spec.ts` on a build without the fix | 2 failed: badge not found in the suite row; filler padding `0px` ×4 vs `4px 8px 4px 8px` |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, web 479/479, 100% coverage in every package |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:e2e` | 109 passed (includes the two new assertions and `text-contrast.spec.ts` on `/benchmarks`, light and dark) |
| `pnpm test:storybook` | 68 files, 304 tests passed (both themes, axe) |

## Review and QA

To be filled in after the review and QA rounds.

## Problems and deviations

None so far.

## Lessons recorded

None so far.

## Not verified

To be filled in.

## Follow-ups

None so far.
