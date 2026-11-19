---
title: Issue 260, the chosen version's format on the artifact page and what "same content" compares
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #260 (follow-up of #246 / PR #259), taken with the maintainer's approval
status: in-progress
branch: feat/issue-260-chosen-version-format
specs: [SPEC-126, SPEC-101, SPEC-103]
---

# Run: Issue 260, chosen version's format and `sameLatestContent`

## Objective

Decide, with the maintainer, which format the Artifacts list and the artifact page show for an
artifact whose chosen version (SPEC-126 FR-126-07) is not its latest one (deferred Q2 of #246), and
whether the Possible duplicates card's `sameLatestContent` compares the chosen versions (deferred
Q3). The maintainer accepts UI decisions only from screenshots or Storybook before any code, so
the run has two phases: A (options with visuals, then stop) and B (spec, implementation, tests).

## Plan

- Phase A: reproduce on `main` with the revert case, capture the current UI, prototype the options
  as throwaway code (not committed), write the decision document, push the branch with this log.
- Phase B (after the decision): spec updates, implementation, database test of the revert case,
  Storybook stories, Playwright in `apps/web/e2e/identity.spec.ts` (both themes, 320 px), full
  gate, browser QA, Codex adversarial review, draft PR, `om-auto-review-pr`.

## Decisions

- Maintainer decision of 2026-11-19 (relayed by the coordinator, recorded on issue #260): Q2
  option C (header format Badge from `artifacts.format`, a muted "latest vN: <format>" Badge only
  when the latest format differs, `ArtifactListItem.format` from `artifacts.format`, FR-101-11
  records that a future `?format=` filter uses `artifacts.format`, the Parsed metadata line
  unchanged); Q3 option Q3-2(a) (`sameContent` compares the chosen versions through a stored
  `artifacts.source_version_id`, "Same content" / "Different content"). Recorded in SPEC-126
  §11.6 J1 to J3; no ADR (precedent: issues 66 and 246).
- Made without asking: no foreign key on `artifacts.source_version_id` (circular with
  `artifact_versions.artifact_id`; drizzle-kit would rebuild the table; versions are deleted only
  with their artifact). A change of the chosen version alone keeps `artifacts.updated_at`, since
  nothing shown changes (as migrations 0009 and 0011 keep it). `insertArtifact` leaves the column
  null; the scan's `refreshSourceFields` sets it in the same transaction.
- Migration number `0011` (`0010` is `0010_text_without_nul`, PR #274).

## Work performed

Phase A (2026-11-19):

1. Worktree `.ai/tmp/issue-260-wt` on `feat/issue-260-chosen-version-format` from `origin/main`
   (6749c20). `pnpm build`, then `.ai/scripts/test-env-up.sh` (port 4398, demo data, mock agent).
2. Reproduction through the UI (register and scan local directories under `/var/tmp`): `repo-a`
   `.cursor/rules/style.mdc` cursor rule v1 → a directory holding skill `style` v2 → the cursor rule
   again (back to v1); `repo-b` another cursor rule `style`; `repo-c` a skill `style`. Database:

   | slug | type | `artifacts.format` | latest version | held by active occurrences |
   | --- | --- | --- | --- | --- |
   | style | rule | cursor-rule | skill-md v2 | v1 |
   | style-2 | rule | cursor-rule | cursor-rule v1 | v1 |
   | style-3 | skill | skill-md | skill-md v1 | v1 |

   The page header of `style` shows the badges "rule" "skill-md" "Possible duplicate"; the card
   lists the cursor rule `style-2`. The list shows no format at all (FR-101-10 has no Format
   column; `ArtifactListItem.format` is data only). The "Latest version (v2) · format skill-md"
   line is the Parsed metadata tab's card description, not the header.
3. Q3 example: three nameless skills `release-notes` (never matched): `repo-d` X v1 → Y v2 → back
   to X, `repo-e` Y, `repo-f` X. Today the card of `release-notes` says "Same latest content" for
   `repo-e` (differs on disk) and "Different content" for `repo-f` (identical on disk).
4. Throwaway prototype (saved as `.ai/tmp/issue-260-proto/prototype.patch`, reverted from the
   worktree): header options A, B, C and the chosen-version comparison, switched per request.
   Screenshots of every option in both themes at 1280 and 320 px.
5. Contrast of the new text measured on rendered pixels: the `muted` badges 5.51 (light) / 5.86
   (dark), "Same content" 19.80 / 17.18.
6. Found while reading: no `?format=` filter exists (`ArtifactListFilter` has none), so no option
   changes current filtering.

Phase B (2026-11-19):

7. Specs first (`b5f77fa`): SPEC-126 FR-126-07, FR-126-11, FR-126-13, A16, A21, UD-5, UD-7, G9,
   G11, G15, G17, §8.1, §8.3, new §11.6 J1 to J3, status; SPEC-101 FR-101-11, §8.2, detail view,
   §14; SPEC-103 §14 case 12; SPEC-006 §3.3.
8. Database (`d691210`): `artifacts.source_version_id`, migration
   `0011_artifact_source_version` (drizzle-kit DDL plus the `0009`-rule backfill), written by
   `importArtifactVersion` and `refreshSourceFields`; `PossibleDuplicate.sameContent` compares
   the chosen versions; `ArtifactListItem.format` is `artifacts.format`. Tests: the revert cases
   in `source-changes.test.ts`, the migration `0011` test, the `0009` test now refreshes on the
   latest schema.
9. Web (`bcf775c`): `latestFormatHint` and the header Badges, "Same content" and the note;
   Storybook story `LatestVersionInAnotherFormat` and detail-view rule 8; e2e in
   `identity.spec.ts` (revert case, both themes, 320 px).
10. Merged `origin/main` (#287, agent-adapters tests only).

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass (after the merge) |
| `pnpm test` (before the merge) | pass, 100% coverage in every package (database 390 tests) |
| `pnpm exec turbo run test --force` (after the merge) | 7/7 tasks, 100% coverage everywhere; a first run at load average 62 (other agents) timed out 2 runner tests at 5 s, which pass alone and in the rerun at load 13 |
| database tests on Node 22.16.0 (SQLite 3.49.1, official tarball, checksum verified) | 390 passed |
| `pnpm build`, `pnpm verify:pack` | pass |
| `pnpm test:e2e` (port 4398) | 206 passed |
| `pnpm test:storybook` | 344 passed |

- Red first: with the old `artifacts.ts` and the new tests, `source-changes.test.ts` had 6
  failures (the three issue 246 list-format rows, the revert comparison, the missing artifact,
  the bundled example).
- Real app (built CLI, port 4398, data under `/var/tmp`): the Phase A scenario now shows
  "rule" "cursor-rule" "latest v2: skill-md" "Possible duplicate"; the `release-notes` card says
  "Different content" for the copy of Y and "Same content" for the copy of X (screenshots in
  `.ai/tmp/issue-260-shots/after*`).
- Upgrade: a copy of that scanned database with the column dropped and `0011` forgotten, migrated
  by `directivebench init`: 1 migration applied, all 7 rows equal to the runtime values, none null.
- Browser QA agent (Playwright Chromium): every check passed (header Badges on all six tabs,
  card contents, invalid ids and `?tab=`, keyboard, both themes and the toggle, 320 px, contrast
  5.51 / 5.86 for the muted Badge, console, no en or em dash). No defect found.
- Codex adversarial review round 1: approve, no findings.

Not verified: Windows; Firefox and WebKit; a hosted repository in the real-app run (unit tests
cover `refreshSourceFields` for every provider); an upgrade of a database built by the `main`
CLI itself (simulated by dropping the column, see above).

## Problems and deviations

- The first reproduction attempt scanned too early: registering a repository does not scan it, so
  the script now scans after every registration.
- Issue 260 names a list "Format column" and a header line "Latest version (vN) · format X"; neither
  exists as described (see step 2). The decision document states what is actually visible.

## Lessons recorded

- [A migration test calls repository code only after migrating to the latest schema](../lessons/2026-11-19-migration-tests-call-runtime-code-on-the-latest-schema.md)

## Follow-ups

- The `?format=` list filter (FR-101-11) is still not implemented; when it is, it filters on
  `artifacts.format`.
- e2e raw-SQL seeds outside `identity.spec.ts` leave `source_version_id` null (their cards show
  "Different content"); harmless for what they assert.
