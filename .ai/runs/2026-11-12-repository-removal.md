---
title: SPEC-125 Phase 2, repository removal (issue 21)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (implement SPEC-125 Phase 2, decisions D12 to D26 approved)
status: completed
branch: feat/repository-removal
specs: [SPEC-125, SPEC-104, SPEC-006, SPEC-014]
---

# Run: SPEC-125 Phase 2, repository removal

Source doc: .ai/specs/2026-11-12-missing-occurrences-and-repository-removal.md

## Objective

Implement Phase 2 of SPEC-125 (issue 21, backlog E02-S03): a registered repository can be
removed from `/repositories` after the inline Risky-action panel states what is deleted and what
is kept; its occurrences are deleted, its artifacts and their history stay (missing when no other
repository has them). UI per the maintainer-approved decisions D12 to D26 (recorded as §11.3).
Acceptance criteria still open after Phase 1: AC-3, AC-7, AC-8, AC-9, AC-10. When all are
verified the spec moves to `implemented/` and the PR closes issue 21.

## Plan

Goal: remove a repository through one database transaction behind a server-rendered
confirmation, without touching files, processes or other data.

Scope: `packages/database` (`getRepositoryRemovalImpact`, `removeRepository`), `apps/web/lib`
(`canRemove`, `parseRemovalParams`, `removalReasons`, `removalResult`, the D23 suffix,
`removeRepositoryAction`), `apps/web/app/repositories/page.tsx` and the artifact page's
Occurrences card (D21), Storybook (D25), Playwright (D26), specs (SPEC-125 §11.3, §20, SPEC-104,
SPEC-006).

Non-goals: repository disable or edit, hosted cache deletion (issue 59), a CLI `repo remove`,
identical accessible names for same-named repositories (issue 215),
`/artifacts?repository=<removed id>` (issue 216), any npm release.

Risks: the removal deletes rows (cascade), so the conditional delete must refuse
`bundled-examples` and the counts must be read in the same transaction; the shared e2e database
must be left as found (lesson 2026-11-10).

## Progress

PR: #217

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Decisions

- [x] 1.1 Record UI decisions D12 to D26 in SPEC-125 §11.3 and correct the spec text — 6acd06e

### Phase 2: Database

- [x] 2.1 getRepositoryRemovalImpact and removeRepository with tests — 618f53a

### Phase 3: Web

- [x] 3.1 Web lib helpers and removeRepositoryAction with unit tests — 9d4a25d
- [x] 3.2 Repositories page, Occurrences card and design-system docs — 91a124f
- [x] 3.3 Playwright: removal flow, contrast and keyboard — 5061a3c, 6bdf943, 7b29282

### Phase 4: Verification and docs

- [x] 4.1 Umbrella spec updates, SPEC-125 implementation status and move to implemented — 28c5bd6
- [x] 4.2 Full gate, real-app run, browser QA, Codex review, run log — a612ece

## Decisions

- Recorded the maintainer-approved UI decisions D12 to D26 as SPEC-125 §11.3 and corrected the
  spec text where the approved deviations change it (D14 question with provider and location,
  D15 re-registration reason and 0-occurrence omission, D18 page-level result line, D19
  fragments, D21 empty Occurrences card, D25 docs).
- `removeRepository` reads the counts with `db.$count` (no `?? 0` branches) and deletes with one
  conditional `DELETE … WHERE id = ? AND provider <> 'bundled-examples'`; when nothing was
  deleted it reads the row once more inside the same transaction to tell `not-removable` from
  `not-found`.
- `removeRepositoryAction` keeps `requireDatabase()` outside the `try`, so an uninitialised data
  directory still fails loudly; only the removal transaction's error becomes `removeError=failed`
  (§13: no console output in the web app, the error text is not shown).
- The panel page decides "That repository is no longer registered." from the listed rows, so a
  crafted `?remove=<bundled-examples id>` shows nothing (§10).
- QA finding: the error redirects carry `#remove-result` too (D19 extension, recorded in §10 and
  §11.3 D19).
- Not changed (D17, accepted): two clicks in the same tick send two posts and the second shows
  "no longer registered" although the first removed the repository; a real double click and
  clicks 50 ms apart sent one post in the browser QA.

## Work performed

1. `bceb753` plan; `6acd06e` SPEC-125 §11.3 decisions and text corrections.
2. `618f53a` database: `getRepositoryRemovalImpact`, `removeRepository`, tests.
3. `9d4a25d` web lib: `canRemove`, `parseRemovalParams`, `removalReasons`, `removalResult`, the
   D23 suffix, `removeRepositoryAction`, unit tests.
4. `91a124f` web pages: row Remove, Risky-action panel, result line, row ids, D21 sentence,
   planned Badge, Risky-action rule 7 and `FromTableRow`, `what-is-missing.mdx`.
5. `5061a3c` Playwright: removal flow, keyboard, 320px, contrast (`missing-occurrences`,
   `text-contrast`, `ui-contrast`).
6. `6bdf943` existing `repositories.spec.ts` row assertions read "ScanRemove"; the story uses the
   design-system Table (lint rule SPEC-121), both found by the first full gate.
7. `7b29282` QA fix: error redirects carry `#remove-result`, with a regression test.
8. `28c5bd6` umbrella specs (SPEC-104 FR-104-15, §10, §20; SPEC-006 occurrence status),
   SPEC-125 §20 and ACs, move to `implemented/`, index, links; lesson.
9. Codex adversarial review round 1 (`--scope branch --base main`, head `28c5bd6`):
   needs-attention, one [high] finding: the correlated `artifactsLeftMissing` count was
   quadratic (a full occurrence scan per artifact, inside the write transaction). `a612ece`
   rewrites it as one grouped pass and adds a linear-time test (29× against the baseline before,
   below 3.5 after). No index migration (A6). Round 2 (head `a612ece`, given the gate results):
   approve, no material findings.
10. `om-auto-review-pr 217 --autofix` (engine `om-code-review`): approve-equivalent, posted as a
    COMMENT (self-review), two nits needing no change; labels `merge-queue`, `needs-qa`,
    `feature`, `priority-medium`, `risk-medium`; manual-QA instructions posted.
11. `om-auto-qa-pr 217`: PASS, ten screenshots posted on the PR through the
    `qa-evidence-pr-217` branch (the bundled-examples location cell, a local home path, was
    replaced with "[local path redacted]" before each screenshot).

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | 7/7 packages pass, 100% statements, branches, functions and lines in each (web 548 tests, database 251) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e` | 151 passed |
| `pnpm test:storybook` | 68 files, 310 tests passed (both themes, axe) |

The table is the third full gate, on head `a612ece` (after the Codex fix); CI on that head passed
every check (Linux and macOS unit tests, integration tests, Storybook, build, CodeQL).

- The first full gate failed `lint` (raw `<table>` in the new story) and 5 `repositories.spec.ts`
  tests (the actions cell now reads "ScanRemove"; 4 of the 5 were the worker restart cascading);
  both fixed in `6bdf943`, and the second full gate above passed.
- Red first: the new database tests import functions that did not exist on `main`; the
  linear-time test failed at 29.1 against the correlated query and passes with the grouped one; the QA
  regression test (`a confirm for a repository removed meanwhile shows the alert in view at
  320px`) failed against the previous `actions.ts` (URL without `#remove-result`) and passes now.
- D19 in Chromium (Playwright): after the GET form the URL is `?remove=<id>#remove-panel` and the
  next Tab focuses "Remove repository", then Cancel; Cancel (a `next/link`) lands on
  `#repository-<id>` and the next Tab focuses the row's Scan, then Remove; the success and error
  Server Action redirects keep their fragment and the line is in the viewport at 320×640.
- Real app: `sh .ai/scripts/test-env-up.sh` (built CLI, demo data, mock agent only) and an
  exploratory browser QA agent (agent-browser) on plain-folder fixtures under `/var/tmp`:
  register, scan, Remove, Cancel, confirm (also by keyboard only), an artifact left with no
  occurrence (D21 sentence, note, "Unknown repository"), the empty scan then Remove (AC-10), a
  repository with no occurrences, the last removable repository (only Bundled examples left,
  without buttons), crafted `?remove=`, count and error parameters, a stale panel across two
  tabs, tampered Server Action ids (bundled, empty, unknown, SQL-like, 100k characters: nothing
  removed), both themes, 320px, console clean, axe clean, no en or em dash in new copy. One
  confirmed defect fixed (error alert below the fold at 320px, `7b29282`); one accepted (D17).

**Not verified:** a GitHub repository's panel in the browser (the hosted reason is unit-tested);
a real `removeError=failed` in the browser (unit-tested with a SQLite trigger); "No artifact
became missing" after a real removal (needs one artifact in two repositories, which no writer
produces yet; unit-tested and checked through the URL); removal while a scan is running (A16
relies on the existing `applyRepositoryScan` re-read, covered by its Phase 1 tests); screen-reader
announcement of the panel.

## Problems and deviations

- Deviations from §11 as first written are the approved D14, D15, D18, D19, D21 and D25, plus the
  QA-driven D19 extension (fragments on the error redirects).
- e2e and the gate ran with `TMPDIR=/var/tmp` (lesson 2026-10-30).

## Lessons recorded

- [Give every redirect outcome of a page-level line its fragment, not only success](../lessons/2026-11-12-every-redirect-outcome-needs-the-line-fragment.md)
- Update to [Timing tests must survive a loaded runner](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md):
  await a Drizzle query in a linear-time baseline (an unawaited builder never runs, which made a
  linear query fail at 11.8).

## Follow-ups

- Issue #215: identical accessible names for same-named repositories ("Scan skills", "Remove
  skills").
- Issue #216: `/artifacts?repository=<removed id>` shows the no-results state while the select
  shows "All".
- Issue #59: delete a hosted repository's cache on removal (the panel says it is planned).
- Phase 1 and Phase 2 ship in the same npm release (§21); no release was cut here.
