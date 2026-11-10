---
title: Versions tab latest badge, hash copy button and first-seen provenance (issue #65)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5
trigger: issue #65 (follow-up of PR #62), run through om-auto-fix-issue (feature route)
status: completed
branch: feat/issue-65-versions-tab-provenance
specs: [SPEC-103, SPEC-101, SPEC-014, SPEC-122]
---

# Run: Versions tab latest badge, hash copy button and first-seen provenance (issue #65)

Source doc: .ai/specs/2026-10-14-artifact-versioning.md

## Objective

Complete the Versions tab of the artifact page as SPEC-103 §11 asks: a "latest" badge on the
newest version, a button that copies the full content hash, and "first seen at
<repo>:<path>@<short sha>" provenance (FR-103-02, FR-103-15). Acceptance criterion of issue
#65: each item is shown and covered by a Playwright test.

## Plan

Goal: on `/artifacts/<id>?tab=versions` a user sees which version is the latest, copies a
version's full hash with one click or key press, and sees where each version was first seen.

Scope: `packages/database/src/repositories/artifacts.ts` (`getArtifactDetail` also returns the
repositories its versions were first seen in), `apps/web/lib/artifact-versions.ts` (new: labels
and the copy helper), `apps/web/app/artifacts/[id]/page.tsx` (`VersionsTab` only),
`apps/web/app/artifacts/[id]/copy-hash-button.tsx` (new client component), unit tests,
`apps/web/e2e/versions.spec.ts`, the contrast specs, `what-is-missing.mdx`, SPEC-103 §20.

Non-goals: the "evaluated on vN, latest is vM" notice (FR-103-13), the "Removed upstream"
banner, per-version evaluation counts in the Versions table, a reusable design-system copy
component, the dash placeholders outside the Versions tab (issue 123). PR #198 edits the
Overview tab and `getArtifactDetail`'s category query; this run stays out of both.

Risks: clipboard access needs a secure context (127.0.0.1 is one; a LAN address over http is
not), so the failure path must say so and show the hash; PR #198 touches the same files.

## Progress

PR: #201

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data and library

- [x] 1.1 `getArtifactDetail` returns the first-seen repositories; tests — c5c3e7e
- [x] 1.2 `lib/artifact-versions.ts`: first-seen label, short commit, copy helper; tests — c5c3e7e

### Phase 2: Versions tab

- [x] 2.1 Latest badge, copy button and First seen column — 3a68130
- [x] 2.2 Design-system backlog row for issue 65 — 3a68130

### Phase 3: Browser tests and docs

- [x] 3.1 Playwright: latest badge, copy, first seen, keyboard, 320px, contrast in both themes — 3a68130
- [x] 3.2 SPEC-103 §20 status, run log — 553b9da

## Decisions

- `getArtifactDetail` gets one extra read-only query (`select distinct` repositories joined
  through `artifact_versions.source_repository_id`) instead of a join on the versions query:
  the versions keep their row shape for every other consumer, and the first-seen repository is
  not always one of the current occurrences' repositories (FR-103-15), so the occurrences could
  not be reused. Ordered by name and id so the result is deterministic.
- The Copy button is a client component local to `app/artifacts/[id]/`, built from `Button`
  (`outline`, `xs`), not a new design-system component; raised in the PR's "Decision needed".
  Its feedback is a `role="status"` line in words (design system: no toast); a refused or
  missing Clipboard API shows the full hash so it can be copied by hand.
- First seen replaces the Source path column (the path is part of the label). The short commit
  is 7 characters (§11 example), the full commit is in the cell's tooltip; the visible short
  hash stays at 16 characters as before.
- The Versions tab's own copy lost its long dashes (hash tooltip, missing path placeholder).
  Other tabs are left to issue 123.
- Imports in `page.tsx` were placed away from the lines PR #198 changes; the branch merges
  cleanly with `feat/category-assignment` (`git merge-tree`).

## Work performed

1. `f25a2d7` execution plan; draft PR #201.
2. `c5c3e7e` `getArtifactDetail` returns `sourceRepositories`; `lib/artifact-versions.ts`
   (`shortHash`, `firstSeenLabel`, `copyText`, `copyStatusMessage`); unit tests.
3. `3a68130` Versions tab: latest badge, Copy button, First seen column; Playwright tests;
   What is missing row.
4. `553b9da` SPEC-103 §20 status.
5. `69d83a0` merge of `origin/main` (PR #200, runner only; no conflicts).
6. Review round 1 (COMMENT, no blockers or majors, one nit kept).
7. `om-auto-qa-pr 201`: PASS with two low defects at 320px (D1 First seen squeezed, D2 refusal
   line broke words); fixed in `ea609a5` with regression assertions (red: width 68.25,
   `word-break: break-all`), re-checked in the browser.

## Verification

Final head `ea609a5` plus this docs commit:

| Command | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test` | pass, every package at 100%: web 510, database 216, runner 250, core 291 (+2 skipped), cli 164, benchmark-engine 518, agent-adapters 364 (+2 skipped); run per package (see deviations) |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:e2e` | 123 passed |
| `pnpm test:storybook` | 304 passed (68 files) |

Red against `origin/main`'s Versions tab: the 6 new or changed `versions.spec.ts` tests fail.
Seam checks (badge on every row, bare source path, 16-character hash given to Copy): 4 of 6
fail with the wrong value shown. QA regressions: red as above.

Real app: `test-env-up.sh` on port 4472 (demo data, mock agent only); a local directory
registered, scanned, edited and rescanned through the UI; a hosted artifact seeded in the QA
database; Copy by pointer and keyboard, refused and missing clipboard, both themes, 320px,
console clean. Evidence: PR #201 comments 6767953948 and 6768003378. Stopped with
`test-env-down.sh`.

Not verified: reading the clipboard back in agent-browser (permission denied there; Playwright
reads it back); a real insecure context (simulated); Firefox and Safari; the Codex adversarial
review (`codex` is not installed on this machine).

## Problems and deviations

- The spec has no Implementation Plan section; the feature route's spec resolution would stop
  there. This run drafted its own short plan from §11 instead (above), as `om-auto-create-pr`
  does.
- `pnpm test` in one parallel run timed out in untouched packages under a load average of 45
  (other agents on the machine), so packages ran one at a time. `apps/cli`'s doctor test
  "warns with a hint when the data directory does not exist yet" fails when a logged-out real
  `claude` is on `PATH` (an agent warning without a hint); with it off `PATH` all 164 pass.
  Neither touches this change.

## Lessons recorded

- Updated [a label squeezed to fit is not a fit](../lessons/2026-10-29-a-label-squeezed-to-fit-is-not-a-fit.md)
  with the `break-all` table-cell case (QA D1).

## Follow-ups

- SPEC-103 §11 items not in issue 65: per-version evaluation counts in the Versions table, the
  "evaluated on vN, latest is vM" notice (FR-103-13), the "Removed upstream" banner.
- A shared `CopyButton` if the maintainer wants one (Decision needed on PR #201).
