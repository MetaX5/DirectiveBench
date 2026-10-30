---
title: SPEC-123 Phase 4, compare the same file between two agent runs
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 4 only), issue #152
status: in-progress
branch: feat/agent-run-output-files-compare
specs: [SPEC-123, SPEC-122, SPEC-014]
---

# Run: SPEC-123 Phase 4, compare page

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** SPEC-123 §21 "Phase 4: Compare": the page
`/results/[id]/compare?case=&left=&right=&path=` (FR-123-30 to FR-123-32, §10, §11, §14) that
shows the union of two agent runs' changed paths and the selected path side by side, reusing the
merged `SideBySideDiff` (variant `change`), `FileView`, `FileStatusBadges` and
`apps/web/lib/line-diff.ts` (PR #155) and the files page and `lib/agent-run-files.ts` (PR #162).
Data only through `@directivebench/database` repositories (`getBenchmarkRunDetail`,
`listAgentRunFiles`, `getAgentRunFile`); the web app runs no process. Plain text only: the
sides' `highlight` prop stays unused but available (Phase 3a, syntax highlighting, is built in
parallel by another agent and wires it in if this PR merges first). Not in scope: Phase 3a and
the blind review (Phase 5); FR-123-52a is kept in mind so the page can later be closed during an
unrevealed review (the page decides from repository data in one Server Component, so a
`hasUnrevealedBlindReview` check can go first). The PR uses `Refs #152`. The maintainer approved
Phases 3a and 4 in parallel on 2026-10-30.

Acceptance: AC-5 (the compare page shows the same path of two agent runs side by side with a
bounded, accessible diff), FR-123-30 to FR-123-32.

## Plan

Engine: om-auto-create-pr (steps: 7, --loop: no).

1. Data and route plumbing (before the UI stop): `apps/web/lib/compare-files.ts` (query parsing
   with Zod, choice of case and agent runs with the spec defaults, union of paths with "only
   left/right", URL builder) with `apps/web/test/compare-files.test.ts` at 100%. No new
   repository function: the page reads `getBenchmarkRunDetail` (agent runs of the run, so a
   foreign id is not found), `listAgentRunFiles` for both sides (metadata) and
   `getAgentRunFile` for at most two files (one path).
2. Stop and return the UI decisions D36 to D45 below.
3. After the decisions: the page `app/results/[id]/compare/page.tsx` and the entry point(s).
4. Playwright: `e2e/compare-files.spec.ts` (defaults, choosing runs and paths, only-left/right,
   identical, too-large, missing side, not found, keyboard, 320 px, both themes) seeded through
   `e2e/output-files-seed.ts`, and `e2e/ui-contrast.spec.ts` for the new texts, badges, diff
   markers and tints.
5. Gate, `directivebench demo` on the built app, browser QA agent, Codex adversarial review,
   `om-auto-review-pr` loop; SPEC-123 §20 for verified behaviour only.

## Decisions

### UI decisions D36 to D45 (proposed, waiting for the maintainer)

Not settled by SPEC-123 (§6.3, §10, §11, §14), D1 to D35 or the design system. Settled and not
repeated here: the URL and its parameters, the defaults "left = baseline repetition 1, right =
candidate repetition 1, path = first path in the union" (FR-123-30), invalid or foreign values
render not found (§10), two `NativeSelect`s with "Baseline (v2), repetition 1" labels, "Only
left" / "Only right" in the path list, the diff and its copy (D4, D9 to D17, FR-123-31/32),
stacking at narrow widths (D14) and "Not present in this agent run." (§14).

- **D36 Entry point.** Proposed: in the run page's "Output files" card, under each case
  heading, a link "Compare agent runs" (accessible name "Compare agent runs of case <id>") to
  `/results/<id>/compare?case=<id>` (the defaults pick the runs). Shown only when the case has at
  least one agent run. Alternatives: also a link on the agent-run files page ("Compare with
  another agent run", left = this run); or one link for the whole card (first case).
- **D37 How the runs are chosen.** Proposed: a `GET` form without client JavaScript: the two
  `NativeSelect`s "Left" and "Right" (one option per agent run of the case) and a `Button`
  "Compare" of the same height (AGENTS.md §7); `case` and the current `path` travel as hidden
  fields. Alternative: a client component that navigates on change (no button, but focus and
  history behave less predictably for keyboard users).
- **D38 Path after changing runs.** The form keeps the current path. If neither newly chosen run
  has it, §10 says a foreign value renders not found, which would punish a normal choice.
  Proposed: a path that is not in the union of the chosen runs shows the first path and the
  `role="status"` line "<path> is not in either agent run, so the first file is shown." (only for
  the path; unknown case or agent-run ids stay not found). Alternative: strict not found (as the
  files page, D33) and the form drops the path, so changing runs always starts at the first file.
- **D39 Option labels and which runs are offered.** Proposed: every agent run of the case,
  baseline first, then by repetition, labelled "Baseline (v2), repetition 1 (passed)" (the D23
  status in parentheses); runs whose files were not kept stay selectable and their side says why
  (D41). The same run may be chosen on both sides (the diff then says "The files are
  identical."). Alternative: offer only runs with kept files, or forbid the same run twice.
- **D40 Defaults the spec does not cover.** Without `?case=`: the first case of the run (in the
  order of the "Output files" card). When the case has no baseline run (or no candidate run), that
  side defaults to the case's first agent run. Implemented in step 1 as proposed; changing it is
  a one-line rule.
- **D41 Sides without kept files.** `SideBySideDiff` says "Not present in this agent run." for a
  side without the path, which is wrong when that agent run kept no files at all. Proposed: above
  the path list, one `role="status"` sentence per such side with the files-page copy (D34):
  "Left: Output files were not kept: <reason>." / "Left: Output files were not kept for this
  agent run." / "Left: The agent did not change any file."; the union then comes from the other
  side. When the union is empty: one `Card` with "Neither agent run has a changed file to
  compare." and no diff.
- **D42 Layout.** Measured from the tokens (app sidebar 14rem, page inline 2rem, card padding
  1rem): with a 14rem path list beside the diff (the files page layout), the diff column at
  1280 px is 720 px (45rem), under `SideBySideDiff`'s 48rem container query, so the two sides
  would stack on a common laptop. Proposed: the path list is a full-width `Card` "Changed paths
  (N)" above the diff `Card`, so the two sides sit side by side from about 1,090 px (960 px of
  diff at 1280 px); below that they stack (left first, "Left" and "Right" headings, D13/D14).
  The page keeps the normal 72rem width. Alternatives: the files page's sidebar layout from `xl`
  only, or `data-layout="wide"` (96rem, as `/artifacts`) for more room on large screens.
- **D43 Path list entries.** Proposed: as the files page (D31): a `nav` "Changed paths" with a
  `ul` of links, path in `font-mono`, `aria-current="page"` and the left border for the selected
  one; a path on one side only shows `FileStatusBadges` with `onlyIn` ("Only left" first, then
  that side's badges); a path on both sides shows no badge (each side's state is in its notices
  above its column). Alternative: an "Identical" / "Differs" badge from the stored `sha256`.
- **D44 Header and navigation.** Proposed: "Back to the run" link (D29), `PageHeader` title
  "Compare output files", description "Case <id> · run <id>" (D28 style), `MockBadge` for mock
  runs; the diff's side headings carry the run labels ("Left: Baseline (v2), repetition 1", D13).
  Path links end in `#diff` with the D35 technique only where the list is stacked above the diff
  (here at every width, D42), so choosing a path scrolls to the diff; focus stays on the link.
  Alternative: no fragment (the page reloads at the top and the user scrolls).
- **D45 Running runs.** Proposed: the page works while the run is running (agent runs appear in
  the selects as they finish), with no auto-refresh and no extra sentence. Alternative: the line
  "Agent runs that finish later appear after a reload."

## Work performed

1. Worktree `.ai/tmp/om-auto-create-pr/agent-run-output-files-compare-*` from `origin/main`
   (71e83ae), branch `feat/agent-run-output-files-compare`.
2. Step 1: `apps/web/lib/compare-files.ts` and `apps/web/test/compare-files.test.ts`
   (9 tests, 100% statements, branches, functions and lines of the file). Stopped and returned
   D36 to D45.

## Verification

- `vitest run test/compare-files.test.ts` with coverage of `lib/compare-files.ts`: 9 passed,
  100% in every metric; `eslint` and `prettier` on both files: clean. The full gate has not run
  yet (no page exists).

## Problems and deviations

None so far.

## Lessons recorded

None yet.

## Follow-ups

- After the maintainer settles D36 to D45: Plan steps 3 to 5.

## Progress

PR: #165

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plumbing

- [x] 1.1 Compare display logic and unit tests — 350c18e
- [x] 1.2 Return UI decisions D36 to D45 (returned, waiting for the maintainer)

### Phase 2: Page

- [ ] 2.1 Compare page and entry point
- [ ] 2.2 Playwright tests and contrast

### Phase 3: Verification

- [ ] 3.1 Full gate and real-app proof
- [ ] 3.2 Browser QA agent and Codex adversarial review
- [ ] 3.3 SPEC-123 §20, run log, lessons
