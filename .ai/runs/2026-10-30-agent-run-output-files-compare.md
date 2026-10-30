---
title: SPEC-123 Phase 4, compare the same file between two agent runs
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 4 only), issue #152
status: completed
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

### UI decisions D36 to D45 (approved by the maintainer on 2026-10-30, D43 changed)

Not settled by SPEC-123 (§6.3, §10, §11, §14), D1 to D35 or the design system. The run stopped
after the plumbing and returned them; on 2026-10-30 the maintainer approved every proposed
default as written, except D43, where the alternative was taken (see D43). Settled and not
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
- **D43 Path list entries (maintainer: alternative taken).** As the files page (D31): a `nav`
  "Changed paths" with a `ul` of links, path in `font-mono`, `aria-current="page"` and the left
  border for the selected one; a path on one side only shows `FileStatusBadges` with `onlyIn`
  ("Only left" first, then that side's badges). **Approved change:** a path on both sides shows
  a badge "Identical" or "Differs" from the stored `sha256` (no content compare): "Identical"
  when both sides have the same change kind and the same original sha256 (two deletions count as
  identical), otherwise "Differs"; a truncated side compares in full because the sha256 is of
  the original bytes. Variant, following D2's logic (a property, not a judgement; green means a
  passed run): `outline` for both, like the change badges and "Only left"/"Only right".
- **D44 Header and navigation.** Proposed: "Back to the run" link (D29), `PageHeader` title
  "Compare output files", description "Case <id> · run <id>" (D28 style), `MockBadge` for mock
  runs; the diff's side headings carry the run labels ("Left: Baseline (v2), repetition 1", D13).
  Path links end in `#diff` with the D35 technique only where the list is stacked above the diff
  (here at every width, D42), so choosing a path scrolls to the diff; focus stays on the link.
  Alternative: no fragment (the page reloads at the top and the user scrolls).
- **D45 Running runs.** Proposed: the page works while the run is running (agent runs appear in
  the selects as they finish), with no auto-refresh and no extra sentence. Alternative: the line
  "Agent runs that finish later appear after a reload."

### Decisions during implementation

- **QA finding 1, sides without kept files.** The browser QA agent found a problem when one
  agent run kept no files: every path of the other side was marked "Only left", and the
  run's column said "Not present in this agent run.". Both claim to know what that run did not
  change, which nobody knows. Fix: `onlyInSide` names a side only when the other run kept its
  files, and `SideBySideDiff` gains an optional `absentNotice` prop. The page fills it with
  the files-page sentence (D34), for example "Output files were not kept: <reason>.". It is an
  additive prop of a design-system component (default behaviour unchanged), with a story
  (`SideWithoutKeptFiles`).
- **QA finding 2, neither side has text.** When both runs deleted a file, the summary said "one
  side has no text". `diffSummary('neither', …)` now says "No line comparison: neither side
  has text to compare.". This is new copy beside D4's sentence, with a story
  (`NeitherSideHasText`).
- QA findings declined, because they follow approved decisions:
  - Changing runs while the form carries the current path can show the D38 fallback line.
    That is D38 as approved.
  - A repeated query parameter counts as absent and takes the default. That is D33's rule,
    shared with the files page, and it shows no other run's data.
  - Raw execution statuses in the options, and the select text cut off at 320px (the full
    label is in the open list), are D39 as approved.

## Work performed

1. Worktree `.ai/tmp/om-auto-create-pr/agent-run-output-files-compare-*` from `origin/main`
   (71e83ae), branch `feat/agent-run-output-files-compare`, draft PR #165.
2. Step 1: `apps/web/lib/compare-files.ts` with `apps/web/test/compare-files.test.ts` (350c18e).
   Stopped and returned D36 to D45. All were approved on 2026-10-30, D43 with the
   alternative.
3. The worktree was recreated from the remote branch. Then (5fd3339):
   - `pairBadge`, `selectComparePath`, `missingPathNotice`, `compareSideNotice` and
     `compareRunOptionLabel` in the lib, at 100%.
   - The page `app/results/[id]/compare/page.tsx`.
   - The "Compare agent runs" link per case on the run page.
   - `e2e/compare-files.spec.ts` with its own seed, `e2e/compare-seed.ts` (kept separate from
     the Phase 3 seed, so the parallel Phase 3a work does not collide).
   - `e2e/ui-contrast.spec.ts` measures the compare link focus outline, the selected-path
     border, the path link focus outline, and the select border and focus ring.
4. Browser QA findings 1 and 2 fixed, with unit, e2e and Storybook regressions (9142932).
5. SPEC-123 §20, this run log, one lesson.

## Verification

- **Red first:**
  - With the compare page removed and the app rebuilt, `playwright test compare-files` failed
    12 of 12.
  - The two QA regressions failed on the build before the fix: "Only left" was still present
    and the "neither side" sentence was missing. They pass after the fix.
- **Full gate on the final code commit:**
  - `pnpm lint` 0, `pnpm format:check` 0, `pnpm typecheck` 0.
  - `pnpm test` 0 (web 421, database 164, engine 516, core 286, adapters 362 + 2 skipped,
    runner 235, cli 159; 100% coverage everywhere).
  - `pnpm build` 0, `pnpm verify:pack` 0 ("Packaging verification passed").
  - `pnpm test:e2e` 85 passed (12 new), `pnpm test:storybook` 302 passed (2 new stories in
    both themes).
  - All commands ran with `TMPDIR=/home/mateusz/.cache/tmp`.
- **Real app:**
  - `directivebench demo` in a fresh data directory under `~/.cache/tmp`, with a fake `claude`
    on `PATH` (as in the e2e config; no real `claude` was run), plus the compare seed. The
    built CLI was served on port 4417.
  - Compare page of the demo run and of the seeded run: light and dark, 1280px and 320px
    (`scrollWidth` equals the viewport, no horizontal scroll), no console or page errors.
  - Rechecked after the QA fixes on the rebuilt server (see the lesson).
- **Browser QA agent** (Playwright; `agent-browser` is not installed) on the built app:
  - No high or medium findings.
  - Two low findings confirmed and fixed (see above); two declined as approved behaviour.
  - Everything else passed:
    - defaults, entry link and back link;
    - not found for 10 foreign or unknown inputs;
    - path fallback for traversal-like, HTML, long and NUL paths;
    - hostile markup shown as text;
    - keyboard order and focus; both themes and the theme toggle; 320px; 1280px side by side;
    - computed contrast; no en or em dash.
- **Not verified:**
  - Screen readers other than the accessibility tree that Playwright reads.
  - Syntax highlighting on the compare page (Phase 3a, built in parallel).
  - Closing the page during a blind review (FR-123-52a, Phase 5). The page loads everything
    in one Server Component, so a `hasUnrevealedBlindReview` check can go first.

## Review

- Codex adversarial review:
  - Round 1, on 5fd3339: approve, no material findings.
  - Round 2, on the branch with the QA fixes: approve, no material findings (52 in-memory
    checks of the missing-file and neutral rendering).

- `om-auto-review-pr` on PR #165, a COMMENT review (own PR), verdict approve. Two minor
  findings were fixed in 631deab:
  - no Playwright test for the "No agent runs recorded." state;
  - the `SideBySideDiff` docs page was stale (it still said no page used the component, and it
    lacked the two new states).
  One minor is left as a follow-up: the page loads `getBenchmarkRunDetail` with every trace to
  pick two runs, the same pattern as the files page. One nit: a non-null assertion in the path
  list.
  After the fixes: `pnpm lint`, `format:check` and `typecheck` all 0, `pnpm test:e2e` 86
  passed, `pnpm test:storybook` 302 passed.

## Problems and deviations

- The first manual restart of the served app left the old server on the port, so the rebuilt
  page seemed unfixed (lesson below). After the server was stopped by its port, the real app
  showed the fixes.
- `SideBySideDiff` gained the optional `absentNotice` prop, and `diffSummary` gained the
  `neither` case (QA finding fixes; additive, stories added).

## Lessons recorded

- [Check that a manual server really restarted before verifying a new build](../lessons/2026-10-30-restart-a-served-build-by-port.md)

## Follow-ups

- Phase 3a (parallel): pass `HighlightResult` to both compare sides when it merges.
- A narrower repository read for the compare and files pages (instead of
  `getBenchmarkRunDetail` with every trace).
- Phase 5: close the compare page during an unrevealed blind review (FR-123-52a).
- Optional, from QA: show a requested path in `font-mono` or quotes in the D38 line (an
  invisible character such as NUL is then easier to see). Optional: give the diff card its own
  heading or landmark.

## Progress

PR: #165

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plumbing

- [x] 1.1 Compare display logic and unit tests — 350c18e
- [x] 1.2 Return UI decisions D36 to D45 (approved 2026-10-30, D43 changed)

### Phase 2: Page

- [x] 2.1 Compare page and entry point — 5fd3339
- [x] 2.2 Playwright tests and contrast — 5fd3339

### Phase 3: Verification

- [x] 3.1 Full gate and real-app proof
- [x] 3.2 Browser QA agent and Codex adversarial review
- [x] 3.3 SPEC-123 §20, run log, lessons
