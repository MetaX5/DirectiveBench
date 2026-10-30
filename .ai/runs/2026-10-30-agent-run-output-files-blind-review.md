---
title: SPEC-123 Phase 5, blind review of baseline and candidate outputs
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 5 only), issue #152
status: in-progress
branch: feat/agent-run-output-files-blind-review
specs: [SPEC-123, SPEC-122, SPEC-014, SPEC-006, SPEC-008]
---

# Run: SPEC-123 Phase 5, blind review

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** SPEC-123 §21 "Phase 5: Blind review" (§6.5, FR-123-50 to FR-123-55 with
FR-123-52a, §8.1 `0004`, §8.3 blind-review repository functions, §10 server actions, §11, §13,
§14, AC-7 and the blind-review part of AC-8). Phase 5 is the last phase of SPEC-123; the
maintainer approved it on 2026-10-30.

In scope:

- Migration `0004_blind_reviews.sql` (`blind_reviews`, `blind_review_pairs`) and the Drizzle
  schema; up/down test pinned to its journal prefix; cascade test.
- Repository functions in `@directivebench/database`: `startBlindReview` (one
  `withTransaction` whose first statement is the conditional `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, random sides with `crypto.randomInt`, shuffled order, pair integrity asserted
  inside the transaction), `getBlindReviewForReviewer`, `getBlindPairFiles`,
  `hasUnrevealedBlindReview`, `recordBlindVerdict` (one conditional `UPDATE … RETURNING`),
  `revealBlindReview` (one conditional `UPDATE … RETURNING`), `getBlindReviewResult`, and the
  eligibility count the run page needs (A8).
- Server-side plumbing in `apps/web/lib`: `BLIND_REVIEW_NOTE_MAX_CHARS` and the shared Zod
  schemas, query parsing (`pair`, `path`), outcome messages (§13), the reveal summary sentence
  (FR-123-54), and the three server actions of §10.
- The `benchmark export` warning while a review is unrevealed (FR-123-52a; Phase 2 follow-up).
- After the UI decisions: the review page `/results/[id]/blind-review`, the run-page card,
  closing every labelled view while unrevealed (the "Output files" card and the "Agent runs"
  section of `/results/[id]`, the files page and the compare page, in HTML and RSC payload),
  the "Human blind review" summary next to the verdict, Playwright (flow, identification
  attempt, keyboard, 320 px, both themes, contrast).

Reused, not redesigned: `SideBySideDiff` variant `neutral` (D12; blind review passes no
`description`, D13), `FileView`, `FileStatusBadges`, `apps/web/lib/compare-files.ts` (#165) and
`highlightTexts` (#166, one job per render).

Not in scope: restarting or deleting a review, several reviewers, blind export (§19), any
change to score, verdict or display status (§4).

## Plan

Engine: om-auto-create-pr (steps: 9, --loop: no).

1. Migration `0004`, schema, migration and cascade tests.
2. Repository functions with tests (concurrency of two parallel starts, conditional verdict and
   reveal with a concurrent second call, unrevealed reads selecting no variant field asserted
   on the returned keys).
3. Web lib plumbing and server actions with unit tests at 100%.
4. `benchmark export` warning with a test.
5. Stop and return the UI decisions D46 and later (draft PR).
6. After the decisions: review page, run-page card and summary, closing of labelled views.
7. Playwright (flow, identification attempt on HTML and RSC payload, keyboard, 320 px, both
   themes, `ui-contrast`).
8. Gate, red-first proof, `directivebench demo` on the built app, browser QA agent, Codex
   adversarial review, `om-auto-review-pr` loop.
9. SPEC-123 §20 for verified behaviour only, run log, lessons.

## Decisions

### UI decisions D46 to D57 (approved by the maintainer on 2026-10-30)

Not settled by SPEC-123 (§6.5, §10, §11, §13, §14), D1 to D45 or the design system. The run
stopped after the plumbing and returned them before any page code; on 2026-10-30 the
maintainer approved every proposed default as written (not the alternatives), relayed by the
coordinator. The text below is the approved text. Settled and not repeated
here: the URL `/results/[id]/blind-review?pair=<n>&path=<p>` with no agent-run id, the fields an
unrevealed pair may show (FR-123-52), the verdict labels and the 2,000-character note (A11),
"Pair 3 of 6" and "Pairs decided: 2 of 6", "Previous pair" / "Next pair", `SideBySideDiff`
`variant="neutral"` with sides "A" and "B" and no `description` (D12, D13), stacking at narrow
widths (D14), one `highlightTexts` job per render in the language of the path (FR-123-76),
"Reveal variants" as a `destructive` `Button` with inline confirmation and its sentence
(FR-123-54), the closed-view sentence of FR-123-52a and `MockBadge` (FR-123-55).

- **D46 Where the review lives on the run page.** §11 asks for a "Blind review" card, and
  FR-123-54 for the revealed summary "next to (not inside) the verdict". Proposed: **one**
  full-width `Card` "Blind review" directly under the three score cards (so it sits next to the
  Comparison card, which holds the verdict), with one body per state: not started (start form,
  D47), unrevealed (progress and a "Continue the blind review" link), revealed (label
  "Human blind review", the summary sentence, "Revealed <date>." and a "View the review" link).
  It never shows a score or changes the verdict. Alternatives: the card after "Warnings" (before
  "Output files") plus a separate summary line under the score cards; or a fourth column in the
  score row (squeezes the three cards at `md`).
- **D47 Starting.** Proposed: in that card, a sentence "Judge the outputs of baseline and
  candidate as unlabelled pairs A and B, then reveal which was which. While the review is open,
  labelled output files and agent runs are hidden.", the count "6 pairs: one per case and
  repetition where both agent runs completed with kept files.", the §14 exclusion lines
  ("1 pair excluded: an agent run did not complete."), and one `Button` (`default`) "Start
  blind review". No confirmation: starting changes no data the user cannot get back (revealing
  restores every view), and the sentence says what happens. On success the action goes to the
  review page (already implemented, `redirect`); a refusal shows its reason as a `role="status"`
  line under the button. Not offered: while the run is `running` ("A blind review can start
  after the run has completed."), for `error`, `cancelled` or `interrupted` runs (same
  sentence with the status), and with no eligible pair ("No pair of completed agent runs with
  kept files.", plus the exclusion lines). Alternative: an inline Risky-action confirmation
  ("Start a blind review of this run? Labelled views stay hidden until you reveal it.").
- **D48 Review page header and task.** Proposed: "Back to the run" link (D29), `PageHeader`
  title "Blind review", description "Pair 3 of 6 · Case `<id>` · run `<id>`", actions
  `MockBadge` for mock runs; under it the `role="status"` line "Pairs decided: 2 of 6". Then a
  `Card` "Task" with the case prompt (from the stored suite definition, in a `Pre`, as the suite
  page shows prompts) and, muted, the residual of FR-123-52a: "Variants, scores and statuses
  are hidden until you reveal them. The per-variant results on the run page stay visible, and
  content written by the agent may still hint at the variant." The case id is shown (it names
  no variant); the repetition is not.
- **D49 Moving between pairs.** Proposed: "Previous pair" / "Next pair" links (§11) above the
  path list and again under the verdict form, plus a `nav` "Pairs" list in its own `Card`
  ("Pair 1 · case-a · A is better", "Pair 2 · case-a · No verdict"; current pair with
  `aria-current` and the D31 left border). Without `?pair=`, the page opens the first pair
  without a verdict (pair 1 once all are decided or after the reveal). A `pair` that is not a
  position of the review is not found (§10). Changing pairs drops `path`. Alternative: only the
  previous/next links (no list; harder to find an undecided pair in a long review).
- **D50 Paths of a pair.** Proposed: the compare page's list (D42, D43): a full-width `Card`
  "Changed paths (N)" above the diff, the union of A's and B's paths (artifact-path entries are
  never listed, FR-123-52), "Only A" / "Only B" (only when the other side kept its files, QA
  finding 1 of Phase 4), "Identical" / "Differs" from the stored sha256, `FileStatusBadges`
  otherwise; links end in `#diff` (D44). Default: the first path. An unknown `path` is not
  found (D33), because the links never produce one. A side whose agent run changed no file uses
  the files-page sentence as its `absentNotice` ("The agent did not change any file."); when
  neither side has a path, one `Card` "Neither side has a changed file to compare." and no diff.
- **D51 Entering a verdict.** Proposed: a `Card` "Your verdict for pair 3" under the diff: the
  sentence "A verdict cannot be changed after you record it.", the `Textarea` "Note (optional)"
  (2,000 characters, field error under it with the text kept, lesson 2026-10-28), then three
  `outline` submit `Button`s "A is better", "B is better", "About the same" (accessible names
  "A is better, pair 3", §11), each submitting the note with it. One click records it; there is
  no second confirmation step (the sentence above warns, and the form is small). While the
  action runs, the buttons are disabled and the status line says "Recording the verdict.". The
  form is a small client component in `app/results/[id]/blind-review/` with `useActionState`
  (the actions already return the metadata-form state). Alternative: choose one of three, then
  a separate "Record verdict" button (two steps, harder to misclick).
- **D52 After recording.** Proposed: the form is replaced by "Your verdict: A is better." and
  the note (escaped, line breaks kept, `wrap-anywhere`), then the `role="status"` line
  "Verdict recorded." with a link "Next pair without a verdict" (or "All pairs have a verdict.
  You can reveal the variants." when none is left). Focus moves to the status line (it gets
  `tabIndex={-1}`), so keyboard and screen-reader users hear the result. No auto-advance. A
  stale form (pair decided elsewhere, review revealed) shows the action's §13 sentence in the
  same line.
- **D53 Reveal and its confirmation.** Proposed: a `Card` "Reveal" at the end of every pair
  page with "Revealing ends the blind review. Pairs without a verdict stay without one." and
  the `destructive` `Button` "Reveal variants". Clicking it shows the Risky-action panel inline
  (client state, no page load): "Reveal the variants of this blind review?", the reasons
  "Revealing ends the blind review. Pairs without a verdict stay without one." and, when some
  are open, "3 of 6 pairs have no verdict.", then the `destructive` `sm` "Reveal variants" and
  "Cancel" (focus returns to the first button). Only on the review page, not on the run page.
  Alternative: the server-rendered second step of `/repositories` ("Register anyway").
- **D54 What the reveal shows.** Proposed: the review page stays (same URLs). At the top a
  `Card` "Result" with the summary sentence (FR-123-54), "Revealed <date>." and a `Table`
  (`aria-label="Blind review result"`): Pair, Case, A, B ("Baseline (v2), repetition 1"),
  Verdict ("A is better"), Preferred ("Candidate", "Baseline", "About the same", "No
  verdict"), Note. On each pair page the diff stays `neutral` with names "A" and "B" and now
  the `description` of each side (D13: "A: Candidate (v3), repetition 1"), plus "View files"
  links per side. The verdict form and the Reveal card are gone; every labelled view of the run
  is open again. The run page card shows the same summary (D46).
- **D55 Closed views while unrevealed (FR-123-52a).** Proposed: on `/results/[id]` the
  "Output files" and "Agent runs" cards keep their titles and show only the sentence "A blind
  review of this run is in progress. Labelled output files and agent runs are hidden until you
  reveal it." with the link "Continue the blind review" (no rows, counts, ids, traces or
  `data-testid="agent-run"`). The files page and the compare page, for any agent-run id or
  query, render "Back to the run", a `PageHeader` "Output files hidden" (files page) or
  "Compare output files" (compare page), and the same sentence and link in one `Card`, with
  status 200 and nothing from the database beyond the run id. The run page's "Agent profile"
  ("Other reported models" is an aggregate over all traces), warnings, score cards and the
  header ("Baseline vs Candidate") stay, as FR-123-52a lists. Alternative for the two pages:
  `notFound()` (a 404 would hide that a review is the reason).
- **D56 Review page without a review, and other states.** Proposed: `/results/[id]/blind-review`
  for a run without a review shows "Back to the run", the `PageHeader` "Blind review" and one
  `Card` "This run has no blind review. Start one from the run page." (no start form there, so
  starting stays one deliberate place, D47); an unknown run is not found. Mock runs: `MockBadge`
  in the header and in the run-page card. No auto-refresh on the review page (the run is
  complete).
- **D57 Narrow screens and keyboard.** Proposed: at 320 px everything stacks (pairs list, task,
  paths, A then B with "A" / "B" headings, verdict, reveal); the three verdict buttons wrap
  onto lines of their own with full button height; the page never scrolls horizontally.
  Tab order follows the page: back link, previous/next, pairs list, paths, the two scroll
  regions (D8), note, verdict buttons, reveal. No shortcuts (D17).

### Decisions during plumbing

- **Pair eligibility (A8)** is computed per case and repetition: a pair needs a `baseline` and a
  `candidate` agent run, both `completed` and with `output_files_kept = 1` (also when they
  changed no file). Other slots count as "did not complete" (a side missing or not
  `completed`) or "files were not kept" (both completed, one not kept);
  `getBlindReviewEligibility` returns the three counts for the run page (§14).
- **Start transaction.** The first statement is `INSERT INTO blind_reviews … SELECT … FROM
  benchmark_runs WHERE id = ? AND status = 'completed' ON CONFLICT(benchmark_run_id) DO NOTHING
  RETURNING id`, so an unknown or unfinished run inserts nothing and is told apart afterwards
  (`not-found`, `not-completed`, `existing`). No eligible pair throws inside the transaction,
  which rolls the review row back (`no-eligible-pairs`). Pair integrity is checked by
  `assertBlindPairIntegrity` against the rows read in the same transaction, and by
  `CHECK (a_agent_run_id <> b_agent_run_id)`; a second CHECK keeps `verdict` to `a`, `b`, `tie`.
- **Reviewer reads by position.** `getBlindPairFiles` takes `{ benchmarkRunId, position, side,
  path }` and returns the side's file list (metadata) plus the content of `path` only, so a
  pair page loads at most two files (FR-123-22), and never returns the agent-run id it joins
  through. It leaves `artifact-path` entries out (A7).
- **Verdict and reveal scope.** As §8.3 says, `recordBlindVerdict` takes the pair id and
  `revealBlindReview` the review id (random ids; neither names a variant). The actions also
  take the run id, only to revalidate `/results/<id>` and its sub-pages.
- **Concurrency tests** use two parallel calls on one connection. Two connections in one
  test process deadlock on SQLite's busy wait (the second `BEGIN IMMEDIATE` blocks the thread
  the first transaction needs), so cross-process safety rests on `BEGIN IMMEDIATE` plus the
  unique index, which the migration test checks.
- **Export warning** goes to stderr, so `--json` still prints one object on stdout.

## Work performed

1. Worktree `.ai/tmp/om-auto-create-pr/agent-run-output-files-blind-review-*` from
   `origin/main` (74f0cee), branch `feat/agent-run-output-files-blind-review`, draft PR #167.
2. Migration `0004_blind_reviews.sql` and the Drizzle schema (`blindReviews`,
   `blindReviewPairs`), with the up/down, constraint and cascade test pinned to its journal
   prefix; the `0003` test now targets its own prefix (2c7ea48).
3. `packages/database/src/repositories/blind-reviews.ts` with
   `packages/database/test/blind-reviews.test.ts` (a431dee).
4. `apps/web/lib/blind-review.ts`, the three server actions in `apps/web/lib/actions.ts`, with
   `apps/web/test/blind-review.test.ts` and new cases in `apps/web/test/actions.test.ts`
   (606dd91).
5. The `benchmark export` warning (FR-123-52a) with a test in
   `apps/cli/test/benchmark-export.test.ts` (597b9e0).
6. Stopped and returned D46 to D57 (no page code yet). All were approved as proposed on
   2026-10-30; the worktree was recreated from the remote branch.
7. The UI (fa3dfc4):
   - the review page `app/results/[id]/blind-review/page.tsx`, with its forms
     (`blind-review-forms.tsx`: start, verdict, reveal);
   - the "Blind review" card on the run page;
   - the closed views (`closed-page.tsx`, the closed "Output files" and "Agent runs" cards);
   - pair navigation, the reveal and the result helpers in `lib/blind-review.ts`;
   - `e2e/blind-review.spec.ts` with `e2e/blind-review-seed.ts`;
   - new controls and the real D12 neutral tint in `e2e/ui-contrast.spec.ts`;
   - the `SideBySideDiff` docs page.
   Without `?pair=` the review page redirects to a URL that names the pair (see the lesson).
8. Browser QA findings 1 and 2 fixed, with Playwright regressions (94965bc).
9. Codex round 1 finding fixed with `loadUnlessBlindReview` on the run, files and compare
   pages, with unit tests (b2f09ed). SPEC-123 §20 and SPEC-006 (§3.16, §3.17) updated.

## Decisions during the UI

- **Default pair in the URL.** The page redirects `/blind-review` to `?pair=<first open>`. If it
  did not, recording a verdict revalidated the page at the *next* open pair, and the result line
  of D52 was lost. The first e2e run found this; the lesson below records it.
- **Outline button borders are not measured.** The outline variant's border is 1.26:1 in light,
  and the same holds for every outline button in the app (for example "Compare" and "Remove").
  The verdict buttons are named by their text and their focus outline reaches 3:1, which
  `ui-contrast` measures. The border is the design system's and is left as it is (follow-up).
- **Browser QA findings declined:**
  - Focus is at the start of the document after a navigation through "Start blind review" or
    "Continue the blind review". That is a page navigation, as everywhere in the app.
  - The reveal panel repeats the card's sentence. That is D53 as approved.
  - Escape does not close the panel. This is not in D53; "Cancel" does.

## Verification

- **Red first:**
  - With the closed views removed (`closed = false`, no check on the files and compare pages)
    and the app rebuilt, `blind-review.spec.ts` failed the identification test. Its HTML and
    RSC payloads named agent-run ids and changed paths.
  - QA finding 1 (double submit): the regression failed on the build before the fix ("This
    pair already has a verdict.").
  - QA finding 2 (case id wrapping mid-word): the regression failed with the old cell classes
    ("case id lines at 1280px").
  - Codex round 1: a unit test flips the review state during the load.
- **Full gate on b2f09ed**, all with `TMPDIR=/var/tmp/mateusz-tmp`:
  - `pnpm lint` 0, `pnpm format:check` 0, `pnpm typecheck` 0.
  - `pnpm test` 0: web 476, database 184, cli 160, engine 516, core 286, adapters 362
    + 2 skipped, runner 235; 100% coverage, no threshold change, no `v8 ignore`.
  - `pnpm build` 0, `pnpm verify:pack` 0 ("Packaging verification passed").
  - `pnpm test:e2e` 103 passed: 11 in `blind-review.spec.ts`, 2 new in `ui-contrast`.
  - `pnpm test:storybook` 304 passed.
- **Real app:** the built CLI ran `directivebench demo` in a fresh data directory under
  `/var/tmp/mateusz-tmp`, with a fake `claude` on `PATH` (no real `claude` was run), and was
  served on port 4440. On the demo run, before and after the fixes:
  - The card showed "3 pairs: …". Start went to `?pair=1`.
  - The run page had 0 `agent-run` elements and the closed cards, in light and dark.
  - At 320 px, `scrollWidth` was 320.
  - Three verdicts, each with its result line, then the reveal. The summary was "Candidate
    preferred in 1 of 3 pairs, baseline in 1, about the same in 1, no verdict in 0."; the run
    card showed "Human blind review" and the 6 agent runs were back.
  - No console or page errors.
  - `benchmark export` of a second demo run with an open review printed the warning on stderr
    and kept `--json` on stdout.
- **Browser QA agent** (Playwright; `agent-browser` is not installed) on the built app:
  - No high findings, and no leak that identifies a side, through the HTML, the RSC payload,
    ids, ordering, classes or titles.
  - Two findings confirmed and fixed (above); three declined (above).
  - Everything else passed: invalid and forged queries, two tabs on one pair, the 2,000
    character limit, hostile notes shown as text, keyboard and focus, both themes, 320 px,
    contrast, and no new en or em dash.
- **Not verified:**
  - Screen readers other than the accessibility tree that Playwright reads.
  - A verdict or a reveal posted from a stale tab after another tab revealed. The unit tests
    cover the repository and the actions.
  - AC-3 and AC-11 in a browser through a real capture (earlier phases, still open in §20).

## Review

- Codex adversarial review:
  - Round 1, on 94965bc: needs-attention, one high finding. The files and compare pages
    checked for an open review only before their awaits. Fixed in b2f09ed.
  - Round 2, on b2f09ed: approve, no material findings.

## Problems and deviations

- **`TMPDIR` under `$HOME` fails the fake-`claude` tests.** With
  `TMPDIR=/home/mateusz/.cache/tmp`, eight `apps/cli/test/benchmark-run.test.ts` cases failed,
  also on `main`. The workspaces then lie below `/home/mateusz`, and the Claude Code adapter
  correctly refuses a workspace with an ancestor `.claude` / `.claude.json`
  (`workspace-contains-claude-config`). The plumbing tests ran with
  `TMPDIR=/var/tmp/directivebench-br5`; after the decisions, the maintainer's setting
  `TMPDIR=/var/tmp/mateusz-tmp` (on disk, outside `$HOME`) was used. Recorded as a lesson
  update.
- At the decision stop, the cleanup removed a `cursor-agent-logs-1000` directory from
  `~/.cache/tmp`. It belongs to another tool (its date matched a test run of this one). From
  then on, only this run's own paths were removed.
- Twice a `pkill`/`pgrep -f` pattern matched this run's own shell command line and ended it
  (exit 144). This is the known pitfall of the 2026-10-14 lesson. Servers were then stopped
  by port only.

## Lessons recorded

- Updated [Keep worktrees and large data off `/tmp`](../lessons/2026-10-30-keep-heavy-data-off-tmp.md):
  a disk `TMPDIR` must lie outside `$HOME`, or the fake-`claude` tests are refused for the
  ancestor `~/.claude`.
- [A view guard on a server page is the last await before the render, and a default selection belongs in the URL](../lessons/2026-10-30-guard-labelled-views-at-render-time.md).

## Follow-ups

- SPEC-123 stays open (`Refs #152`). AC-3 and AC-11 still need a browser check through a real
  capture (a planted secret, an `assertion-error` agent run); NFR-123-01 has no timing test.
- The outline `Button` border is 1.26:1 in light mode (design system, all outline buttons).
- A narrower repository read for the run, files, compare and review pages, instead of
  `getBenchmarkRunDetail` with every trace (carried over from Phase 4).
- Restarting or discarding a review, and a blind export (§19).

## Progress

PR: #167

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plumbing

- [x] 1.1 Migration 0004 and schema — 2c7ea48
- [x] 1.2 Blind-review repository functions — a431dee
- [x] 1.3 Web lib plumbing and server actions — 606dd91
- [x] 1.4 Export warning — 597b9e0
- [x] 1.5 Return UI decisions D46 and later (D46 to D57, approved 2026-10-30)

### Phase 2: UI

- [x] 2.1 Review page, run-page card and summary, closed labelled views — fa3dfc4
- [x] 2.2 Playwright tests and contrast — fa3dfc4

### Phase 3: Verification

- [x] 3.1 Full gate, red-first proof and real-app proof — b2f09ed
- [ ] 3.2 Browser QA agent, Codex adversarial review and om-auto-review-pr
- [x] 3.3 SPEC-123 §20, run log, lessons
