---
title: SPEC-123 Phase 3, run page "Output files" card and agent-run files page
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 3 only), issue #152
status: in-progress
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

### Open UI decisions for the maintainer (D21 to D34), not settled by SPEC-123, D1 to D20 or the design system

The run stopped here before any page code, as asked. Each item has a proposed default.

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

No other decision is needed: badges, notices, file header, line numbers, scroll region and copy
inside the file view come from D1 to D19 and FR-123-21; plain text per the brief.

## Work performed

1. Worktree from `origin/main` (f439c6b), branch `feat/agent-run-output-files-pages`.
2. `countAgentRunFiles` in `packages/database/src/repositories/runs.ts` with a unit test.

## Verification

- `pnpm --filter @directivebench/database exec vitest run test/runs.test.ts --coverage.enabled=false`:
  19 passed. The full gate has not run yet (the run is stopped for D21 to D34).

## Problems and deviations

None yet.

## Lessons recorded

None yet.

## Follow-ups

- Resume after the maintainer's answers to D21 to D34: steps 2 to 6 of the plan.
