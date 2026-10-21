---
title: Render short GFM table rows to the header width (issue #56)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: issue #56 (follow-up from the PR #50 review), om-auto-fix-issue
status: completed
branch: fix/issue-56-table-row-width
specs: [SPEC-101]
---

# Run: Render short GFM table rows to the header width (issue #56)

## Objective

Since the PR #50 fix of the table blow-up, a short table row rendered fewer `<td>` than the
header has `<th>`. Restore the header width without letting the cell count grow with
header width × rows, keep it linear in the input, regression-test with the review's large-table
input, and reword SPEC-101 §12 "output never larger than the input" to "linear in the input".

## Plan

1. Parser (`apps/web/lib/markdown.ts`): a table row becomes `{ cells, missing }`, where `missing`
   is the number of header columns the row leaves empty.
2. Renderer (`apps/web/components/artifacts/markdown.tsx`): one trailing `<td colSpan={missing}>`
   when `missing > 0`.
3. Unit test with the PR #50 input (25 000 columns × 2 000 empty rows): every row reaches the
   header width, rendered cells = 2 per row, parse under 1 s.
4. e2e: a short-row table in the `e2e-safe-preview` fixture, rows checked for cells and `colspan`.
5. SPEC-101 §12 reworded, §20 status line; lesson about the table blow-up corrected.

## Decisions

- The missing-column count lives in the parser (unit-covered `apps/web/lib`), not in the
  component, so the logic is under the 100% coverage gate and the renderer only maps it.
- One spanning cell per short row rather than per-column padding: at most two cells per row line.
- Browsers clamp `colspan` at 1000, so a row of a table wider than 1000 columns still ends short.
  Splitting into several spanning cells would bring back a (smaller) width × rows product; the
  limitation is stated in §12 instead.

## Work performed

- `fix(web): render short GFM table rows to the header width` — parser, renderer, unit and e2e
  tests, SPEC-101 §12/§20, lesson update, this run log.

## Verification

- `pnpm format:check` — pass.
- `pnpm lint && pnpm typecheck && pnpm test` — pass; all 7 test tasks green, 100% coverage
  threshold met (web: 8 test files).
- `pnpm build && pnpm verify:pack && pnpm test:e2e` — pass; 37 Playwright tests passed.
- Large input: the unit test parses 25 000 columns × 2 000 empty rows in well under the 1 s
  bound; 4 000 rendered cells instead of the 50 million padding would produce.
- Real built CLI: `node apps/cli/dist/cli.js --data-dir <tmp> serve`, registered and scanned a
  local directory with a `SKILL.md` containing a 3-column table and a `| short |` row. The
  rendered HTML was `<td>short</td><td colspan="2"></td>`; every row's colspan sum was 3.
- Not verified: rendering of tables wider than 1000 columns in a browser (documented limitation).

## Problems and deviations

None.

## Lessons recorded

- Updated [An alias limit is not a size limit](../lessons/2026-10-20-alias-limits-are-not-size-limits.md):
  the table case now states the bound as "linear in the input" (a `colspan` cell adds HTML bytes,
  not cells). No new lesson.

## Follow-ups

- None required. If tables wider than 1000 columns ever matter, revisit the `colspan` clamp.
