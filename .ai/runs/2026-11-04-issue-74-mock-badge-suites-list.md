---
title: Mock badge on the suites list, mock-agent doc comment, table filler padding (issue #74)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #74, decisions D1 to D7 and Q3 approved by the maintainer on 2026-11-04
status: completed
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

- `om-auto-review-pr --autofix` (engine `om-code-review`): approve with no findings, posted as
  COMMENT ([review](https://github.com/MetaX5/DirectiveBench/pull/183#pullrequestreview-5773967985)).
  The full gate was re-run on head `02e5afe` and passed. No autofix was needed.
- Codex adversarial review (plugin `codex` 1.0.6, `adversarial-review --wait --base origin/main`),
  round 1 on `02e5afe`: approve, no material findings.
- `om-auto-qa-pr` (agent-browser 0.35.2 on the built CLI after `directivebench demo`): PASS on
  9 of 9 checkpoints ([evidence](https://github.com/MetaX5/DirectiveBench/pull/183#issuecomment-6639335281),
  images on `qa-evidence-pr-183`). Covered: `/benchmarks` in both themes at 1280px and 320px
  (badge contrast 6.87 light, 7.73 dark; at 320px the badge wraps in its cell exactly as on
  `/results`, with no page scroll); keyboard only (the badge is not a focus stop, and Enter opens
  the suite); the filler cell of a short Markdown row (computed `4px 8px 4px 8px`, top-aligned,
  row width equal to header width) in both themes; an invalid repository path; a clean console.

## Problems and deviations

- QA booted the built CLI by hand, as `apps/web/playwright.config.ts` does (`demo`, then `serve
  --no-open`), instead of through `om-prepare-test-env`. That skill generates
  `.ai/scripts/test-env-*.sh`, and this run was told not to touch `.ai/scripts/` (another branch
  is adding those scripts).

## Lessons recorded

None. Nothing non-obvious came up.

## Not verified

- Firefox and Safari (only Chromium was used).
- Hover in the exploratory QA: headless agent-browser reports `(hover: hover)` false. The badge
  hover contrast is covered by the e2e `text-contrast.spec.ts` scan in Playwright.

## Follow-ups

None.
