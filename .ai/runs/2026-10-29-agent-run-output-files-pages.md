---
title: SPEC-123 Phase 3, run page "Output files" card and agent-run files page
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 3 only), issue #152
status: completed
branch: feat/agent-run-output-files-pages
specs: [SPEC-123, SPEC-113, SPEC-122, SPEC-014]
---

# Run: SPEC-123 Phase 3, run page and files page

## Objective

Implement **only** SPEC-123 §21 "Phase 3: Run page and files page": the "Output files" card on
`/results/[id]` (FR-123-20) and the page `/results/[id]/agent-runs/[agentRunId]` (FR-123-21,
FR-123-22, §11), reusing the merged `FileView` and `FileStatusBadges` (PR #155, D1 to D20
approved) without redesigning them. Data only through `@directivebench/database`
(`listAgentRunFiles`, `getAgentRunFile` from Phase 1, PR #157). Plain text only: no
`HighlightResult` (Phase 3a). Not in scope: CLI export (Phase 2, another agent, `apps/cli`
untouched), compare (Phase 4), blind review (Phase 5). The PR uses `Refs #152`.

The maintainer approved Phases 2 and 3 on 2026-10-29, which also settles A14 (the components
merged with #155).

## Plan

1. Data layer (done before the UI stop): `countAgentRunFiles(db, benchmarkRunId)` in
   `@directivebench/database`, per agent run `files`, `truncated`, `notKept`, `storedBytes`
   computed in SQL, so the run page loads no file content (FR-123-22). Unit test in
   `packages/database/test/runs.test.ts`.
2. After the maintainer settles D21 to D34 below: display logic in `apps/web/lib/output-files.ts`
   (row data, agent-run label, Zod parse of `?path=`), 100% unit coverage.
3. "Output files" card on `/results/[id]`.
4. `/results/[id]/agent-runs/[agentRunId]` page (`notFound()` for a foreign or unknown agent run
   or path).
5. Playwright: run card, files page (list, selection, notices, not found), keyboard, 320 px, both
   themes, `ui-contrast` measurement of the new texts and badges; seeded through
   `e2e/results-seed.ts` with mock-agent rows.
6. Gate, `directivebench demo` on the built app, browser QA agent, Codex adversarial review,
   PR (`Refs #152`), `om-auto-review-pr` loop; SPEC-123 §20 for verified behaviour only.

## Decisions

### UI decisions D21 to D34 (approved by the maintainer on 2026-10-29)

These were not settled by SPEC-123, D1 to D20 or the design system. The run stopped before any
page code and returned them; the maintainer approved every proposed default as written (not the
alternatives) on 2026-10-29, relayed by the coordinator. The text below is the approved text.

- **D21 Card placement.** §11 says "below the existing comparison", but the page has, in order:
  the three score cards, Agent profile, Warnings, Agent runs, Environment. Proposed: directly
  after the Warnings card and before "Agent runs" (the first section about individual agent
  runs). Alternative: right after the score cards (before Agent profile).
- **D22 Card structure.** Proposed: one `Card` "Output files", description "Files each agent run
  added, changed or deleted. Up to 1 MB per file and 10 MB per agent run are kept, with secrets
  redacted."; inside, one `h3` per case (case id in `font-mono`) and one `Table` per case with
  `aria-label="Output files of case <id>"`. Alternative: one table with a Case column (fewer
  headings, but the case repeats on every row).
- **D23 Columns and copy.** Proposed: "Agent run" ("Baseline (v2), repetition 1", from the
  existing `baselineLabel`/`candidateLabel`), "Status" (the execution status as the Agent runs
  section shows it: `completed`, `agent-error`, `timeout`, ... in a `Badge`, the same mapping),
  "Changed files" (count), "Kept" (`formatSize` of stored bytes), "Not complete" ("None",
  "1 truncated", "2 not kept", "1 truncated, 2 not kept"; deleted files count as not kept, as
  in `countAgentRunFiles`), last column the link. Is the variant shown with the existing red and
  green variant `Badge` as in "Agent runs", or as plain text? Proposed: plain text (the card is
  about files; colour would add nothing).
- **D24 Link copy and accessible name.** Proposed: visible "View files", accessible name
  "View files of Baseline (v2), repetition 1, case extend-existing-block" (`aria-label`), a
  normal underlined link (`text-primary-text`), not a button.
- **D25 Agent runs whose files were not kept.** Proposed: the row stays; "Changed files" shows
  the count from `agent_runs.changed_files`, "Kept" shows "Not kept", "Not complete" shows the
  stored reason as a sentence ("Not kept: the agent did not stop after its timeout."), and the
  "View files" link is still shown (the page explains). Alternative: no link for these rows.
- **D26 Whole-run "not kept" copy.** FR-123-20 gives "Output files were not kept for this run."
  for a run whose agent runs predate the spec. Proposed rule: the sentence replaces the tables
  when **every** agent run has `output_files_kept = 0` and no reason (pre-spec rows); when only
  some do, their rows say "Not kept: this agent run predates output file capture."
- **D27 Running runs and no agent runs.** Proposed: while the run is running, rows appear as
  agent runs finish (the page already auto-refreshes) with the line "Files of finished agent
  runs appear here while the run continues."; with no agent run at all, the card says "No agent
  runs recorded." (the existing Agent runs copy).
- **D28 Files page header.** Proposed: `PageHeader` title "Candidate (v3), repetition 2",
  description "Case <id in font-mono> · run <id in font-mono>" (the "·" separator the run page
  already uses), actions: the execution status `Badge` and `MockBadge` for mock runs.
- **D29 Navigation back.** There is no breadcrumb pattern or primitive. Proposed: a plain link
  "Back to the run" above the page header (as `not-found.tsx` uses "Back to the dashboard"),
  pointing to `/results/<id>`. Alternative: the run id in the description as the link.
- **D30 Layout and 320 px.** Proposed: two columns from `lg` (file list `w-sidebar`-like fixed
  column, file view takes the rest; the list is a `Card` "Changed files (N)", the view a `Card`
  with the `FileView`); below `lg` the list stacks above the file. Should the list stay sticky
  while a long file scrolls? Proposed: no (simpler, D6 already lets a long file grow the page).
- **D31 File list markup and order.** Proposed: a `nav` with `aria-label="Changed files"` and a
  `ul` of links, one per file: path in `font-mono` (wraps anywhere), `FileStatusBadges` and the
  size (`formatSize`, "deleted" files no size); the selected file has `aria-current="page"` and a
  visible non-colour cue (left border plus `font-medium`). Order: by path, code-point ascending
  (as `listAgentRunFiles` returns it). Alternative orders: changed kind first, or kept files
  first.
- **D32 Default selection.** Without `?path=`, proposed: show the first file of the list (so the
  page is never empty when files exist). Alternative: no file selected and the sentence "Choose
  a file to read it." The URL changes to `?path=` only on a click.
- **D33 Unknown or foreign `?path=` and ids.** §10 says invalid or foreign values render
  not found. Proposed: an agent run of another benchmark run, an unknown agent run id or a
  `?path=` that is not a listed file all call `notFound()` (the app's 404 page); an empty or
  repeated `?path=` is treated as absent (Zod: one non-empty string, at most the stored path
  length). Alternative for an unknown path: keep the page and say "This file is not in the
  agent run." under the list.
- **D34 Empty and not-kept states of the page.** Proposed copy, in the file column: kept and no
  file changed: "The agent did not change any file." (§14); not kept with a reason: "Output
  files were not kept: <reason>." (§14 pattern, reason as stored, already redacted); not kept,
  pre-spec row: "Output files were not kept for this agent run."; the list card then shows
  `EmptyState`? Proposed: no list card at all in these states, only the sentence in one `Card`.

- **D35 Scroll to the file only where it is stacked (maintainer decision on PR #162,
  2026-10-29).** Choosing a file scrolls to the file only below `lg`, where the list stacks
  above it; side by side the page does not scroll and the header stays in view. Implemented
  without JavaScript: the `#file` target is an absolutely positioned, `aria-hidden` span at the
  top of the file card with `lg:hidden`, so on wide screens it has no box and both the browser
  and Next.js's hash scroll (`scrollIntoView` on the target) leave the page where it is. Focus
  stays on the activated file link at both widths. Tests: wide (1280x720, scroll position
  unchanged after the click, header and back link in view, a fresh load of the `#file` URL
  stays at the top) and 320px (the file heading is in view). The wide test failed on the
  previous build (scroll position changed) and passes now.

No other decision is needed: badges, notices, file header, line numbers, scroll region and copy
inside the file view come from D1 to D19 and FR-123-21; plain text per the brief.

## Work performed

1. Worktree from `origin/main` (f439c6b), branch `feat/agent-run-output-files-pages`.
2. `countAgentRunFiles` in `packages/database/src/repositories/runs.ts` with a unit test
   (7841cf3). Stopped and returned D21 to D34; approved on 2026-10-29.
3. `apps/web/lib/agent-run-files.ts` (status badge mapping shared with the "Agent runs" section,
   labels, row cells, notices, `?path=` parsing, file selection, URLs) with
   `apps/web/test/agent-run-files.test.ts` at 100%; the "Output files" card on `/results/[id]`;
   the page `/results/[id]/agent-runs/[agentRunId]`; `e2e/agent-run-files.spec.ts` with the seed
   `e2e/output-files-seed.ts`; the text-contrast scanner moved unchanged to `e2e/contrast.ts` so
   both specs use it; `e2e/ui-contrast.spec.ts` measures the selected-file border and the link
   focus outlines (854c1ce).
4. Browser QA finding 1 fixed with a regression test (52703b0), see below.
5. SPEC-123 §20, this run log and a lesson.

## Verification

- Red first: with the two pages removed and the app rebuilt, `playwright test agent-run-files`
  failed 7 of 9 (the two contrast tests passed on the 404 page, so they now assert the page is
  not the 404 page first). The QA regression test failed on the previous build
  (`toBeInViewport`) and passes after the fix.
- Full gate after the last code change: `pnpm lint` 0, `pnpm format:check` 0, `pnpm typecheck`
  0, `pnpm test` 0 (web 407, database 164, engine 516, core 286, adapters 362 + 2 skipped,
  runner 234, cli 132; 100% coverage everywhere), `pnpm build` 0, `pnpm verify:pack` 0
  ("Packaging verification passed"), `pnpm test:e2e` 72 passed, `pnpm test:storybook` 298
  passed. The first storybook run of the session had 5 timeouts in untouched stories
  (theme toggle, status badge, typography, nav, colour; cold cache); the rerun and the final
  gate passed all 298.
- Real app: `directivebench demo` in a fresh data directory, the built CLI served on port 4411.
  The run page card and a files page were checked in light and dark, at 1280px and 320px (no
  horizontal page scroll), with no console error; seeded states checked the same way.
- Browser QA agent (Playwright, `agent-browser` not installed) on the built app: one confirmed
  defect (medium): at 320px, choosing a file reloaded the page at the top while the file is
  stacked below the list, so nothing seemed to change. Fixed: file links carry `#file`;
  regression test at 320x640 (narrowed to small screens by D35). Its low-severity
  suggestions: size placement uneven (fixed: the size now has its own line); seeded
  `changed_files` did not match the seeded files (fixed in the seed); a repeated `?path=` shows
  the first file (D33 as approved, unchanged); the file `h3` sits after the list card's `h2` (the
  `FileView` heading is D3, unchanged); the case table's scroll container and table carry the
  same `aria-label` (the existing `Table` primitive, unchanged); the 404 keeps the route's title
  (as on other routes). Everything else passed: flows, 40+ invalid ids and paths, keyboard
  order and focus, both themes and the toggle, 320px, contrast (lowest 5.51:1 light, 5.19:1
  dark), no console errors, no en or em dash in the new copy.
- Not verified: a fake-`claude` run in the browser; a planted secret through a real capture and
  an `assertion-error` run shown end to end (AC-3, AC-11 stay partial); screen readers other
  than the accessibility tree that Playwright reads.

## Review

- Codex adversarial review: round 1 no material findings (needs-attention only for the gate it
  could not run); round 2 with the recorded gate and QA results: approve, no findings.
- `om-auto-review-pr` on PR #162 (COMMENT, own PR): approve. One minor (the files page loads
  `getBenchmarkRunDetail` for one agent run; a narrower repository read is a follow-up) and one
  nit (no e2e for `timeout`/`agent-error` badges in the existing "Agent runs" section). CI on
  `8219a9b`: all nine checks passed; PR mergeable.

## Problems and deviations

- `demoRunId` returns the oldest run, and the first seed used a fixed date earlier than the demo
  run, so "the demo run" resolved to the seed. Seeds now use the current time (lesson below).
- Browser QA fix beyond D30/D31: the `#file` fragment first also scrolled the file card to the
  top on wide screens, hiding the header. Resolved by D35. The size of a file in the
  list is on its own line under the badges.
- The "Agent runs" section's status badge now uses the same helper as the card (same mapping,
  no visible change).

## Lessons recorded

- [Seeded e2e runs must be newer than the demo run; stacked details need a fragment](../lessons/2026-10-29-e2e-seeds-must-not-become-the-demo-run.md)

## Follow-ups

- A repository read for one agent run within its benchmark run, so the files page does not load
  every agent run's trace (review minor on #162).

- Phase 3a: highlight the files page (`highlightLines` in this Server Component).
- Phase 4 (compare) and Phase 5 (blind review, which must close this card and page while a review
  is unrevealed, FR-123-52a).
