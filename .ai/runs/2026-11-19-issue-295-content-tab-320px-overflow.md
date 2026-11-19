---
title: Issue 295, Content tab scrolls sideways at 320px with a long raw line
date: 2026-11-19
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue, brief mode)
trigger: user request (problem found by the browser QA agent of PR #293)
status: completed
branch: fix/issue-295-content-tab-320px-overflow
specs: [SPEC-122]
---

# Run: Content tab scrolls sideways at 320px with a long raw line

## Objective

File the problem as an issue (#295), then fix it from evidence: at 320px the artifact Content
tab must not scroll horizontally when a file has a long line; the raw view wraps or scrolls in
its own box. A Playwright regression test must fail before the fix.

## Plan

1. Dedupe and file the issue; claim it for cieslinho.
2. Reproduce at 320px on the built app (own port 4417, own data dir under `.ai/tmp/`).
3. Root-cause fix with the smallest diff (PRs #293 and #294 edit the same file).
4. e2e regression test, red first; quality gate including `test:e2e` and `test:storybook`.
5. Browser QA agent (headless Playwright, own download dir), PR, `om-auto-review-pr`.

## Decisions

- **`grid-cols-1` on the layout grid instead of `min-w-0` on the content column.** The grid
  only set `lg:grid-cols-4`, so below `lg` it had one implicit `auto` column that grew to the
  min-content of the widest item. `grid-cols-1` (`minmax(0, 1fr)`) matches the `lg:` tracks,
  is one class on the layout element and also bounds the left column (a long file name in the
  tree), which `min-w-0` on one child would not.
- The test seeds its own artifact (distinct name, slug and content hash) and removes it, so the
  shared e2e database is unchanged for other spec files.

## Work performed

1. Filed #295 (bug, priority-low, risk-low), assigned cieslinho, `in-progress`, claim comment.
2. Reproduced: demo SKILL.md (longest line 175 characters, with spaces) does not overflow
   because `Pre` wraps at spaces; a line without a break opportunity does (`scrollWidth` 1663
   with a 220-character URL, 2530 in the e2e seed). Root cause above; `break-words` does not
   lower min-content (existing lesson 2026-10-28).
3. Fix in `apps/web/components/artifacts/content-tab.tsx` (one class).
4. Regression test `apps/web/e2e/content-tab-narrow.spec.ts`.
5. Updated the existing lesson instead of adding a near-duplicate.

## Verification

| Command | Result |
| --- | --- |
| `playwright test e2e/content-tab-narrow.spec.ts` before the fix | failed: `scrollWidth` 2530 > 320 |
| same, after the fix | passed |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | passed (7/7 tasks, 100% coverage); a first run failed on runner coverage (`repository-registration.ts:323`, a timing branch), unrelated and green on rerun |
| `pnpm build && pnpm verify:pack` | passed |
| `pnpm test:e2e` | 211 passed |
| `pnpm test:storybook` | 68 files, 346 tests passed |
| Real app at 320/768/1280 (demo data plus a long URL line) | no horizontal page scroll; raw view inside the viewport |
| Browser QA agent (headless Playwright Chromium, own download dir, port 4417) | pass: no page scroll at 320/375/768/1023/1024/1280/1920 in both themes; stacked below 1024, 1/4 + 3/4 from 1024; keyboard reaches the raw view (12th Tab, focus ring visible, ArrowDown scrolls); no console messages; invalid `file`/`version` values show notices; other tabs fit 320 |

Not verified: Windows, Firefox/WebKit, a real phone. Codex adversarial review not run (Codex
CLI is not installed).

## Problems and deviations

- `pnpm` was not on PATH; turbo needs it, so a corepack shim directory under `.ai/tmp/` was
  used and removed afterwards.
- Pre-existing, not changed here: a long unbroken token in the **Rendered** Markdown section is
  clipped by the Card (`overflow-hidden`) at every width, including 1280px. Before this fix
  the 320px page scrolled sideways to it; now it is clipped like on desktop. Follow-up.

## Lessons recorded

- Updated [lessons/2026-10-28-long-words-widen-grid-cards.md](../lessons/2026-10-28-long-words-widen-grid-cards.md):
  a grid with only breakpoint columns has an implicit `auto` column below the breakpoint.

## Follow-ups

- Rendered Markdown: wrap long unbroken tokens (`wrap-anywhere`) so they are not clipped.
- May need a rebase after PRs #293 and #294 (same file).
