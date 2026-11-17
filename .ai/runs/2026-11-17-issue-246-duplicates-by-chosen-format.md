---
title: Possible duplicates keyed on the chosen version's format (issue 246, option B)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue #246, maintainer decision of 2026-11-17 (option B)
status: completed
branch: fix/issue-246-duplicates-by-chosen-format
specs: [SPEC-126, SPEC-103, SPEC-101, SPEC-006]
---

# Run: Possible duplicates keyed on the chosen version's format (issue 246)

## Objective

After a revert to a version of another format (or the removal of the repository holding the
highest version), possible-duplicate groups keyed on `artifacts.type` plus the latest version's
format, so a same-named artifact of the on-disk format was not flagged. Option B: store the
chosen version's format as the source field `artifacts.format` (FR-126-07 / FR-103-16) and key
the groups on `(format, name)` with the index `artifacts_format_name_idx`.

## Plan

1. Specs first: SPEC-126 (FR-126-07, FR-126-11, A15, NFR-126-02, §8.1, G14, §20), SPEC-103
   (FR-103-16, §14 case 2, known limitation removed), SPEC-101 (§8.2, §8.3, FR-101-10), SPEC-006
   (§3.3).
2. Red-first database tests: the revert case in the list count and the detail card, the removal
   case, the migration `0009` backfill on a `0008` database, the query plan on the new index.
3. Code: schema column and index, migration `0009` (DDL plus a hand-written backfill), write
   paths `insertArtifact`, `importArtifactVersion`, `refreshSourceFields`; the grouped statement
   and the detail lookup read `artifacts.format`.
4. e2e raw-SQL seeds that expect a "Possible duplicate" Badge set `format`.
5. Separate commit: the PR #256 follow-up (share the representative-occurrence order).
6. Gate, real-app run (revert case, upgrade from a `main` database), Codex, om-auto-review-pr.

## Decisions

- Migration `0009` keeps `updated_at`: adding a derived column changes no user-visible field.
- The detail card's lookup left-joins the latest version, so a hand-made row with a stored format
  and no version is listed exactly when the list counts it (`sameLatestContent` false); scans never
  write such a row (SPEC-006 §3.3: null only without a version).
- e2e: the issue 227 artifact twin (a row copy of the demo artifact without a version) gets
  `format: null`, so it stays a name clash only and its pages are unchanged.
- PR #256 follow-up: one comparator (`compareRepresentative`) for `refreshSourceFields` and the
  install folder; `getInstallableArtifactBundle` folded into `getArtifactBundle` (runner and CLI
  call it directly). Making `ArtifactBundle.folderName` required was skipped: it would touch every
  hand-built bundle in about ten test files of `agent-adapters`, `benchmark-engine` and `apps/cli`
  for no behaviour change.

## Work performed

1. `ebc50cd` docs(specs): SPEC-126 (FR-126-07, FR-126-11, A15, NFR-126-02, §8.1, §8.3, G14, §14),
   SPEC-103 (FR-103-16, §14 case 2, new case 12, known limitation removed), SPEC-101 (§8.2, §8.3,
   FR-101-10), SPEC-006 (§3.3). Draft PR #259 opened.
2. `83ca766` red tests: `source-changes.test.ts` "possible duplicates follow the chosen version"
   (revert both ways, FR-126-23 removal, missing artifact) and format assertions on the issue 66
   tests; `client.test.ts` migration `0009` test; `identity.test.ts` query-plan tests.
3. `e6ca93d` fix: `artifacts.format` (schema, migration `0009` with backfill and
   `artifacts_format_name_idx`), written by `insertArtifact`, `importArtifactVersion`,
   `refreshSourceFields`; `possibleDuplicateGroups` and `readPossibleDuplicates` key on
   `(format, name)`; e2e raw-SQL seeds set the stored format.
4. `70e1383` refactor (PR #256 follow-up): `compareRepresentative` shared by `refreshSourceFields`
   and the install folder; `getInstallableArtifactBundle` folded into `getArtifactBundle`
   (`artifact-bundles.ts` removed; runner and CLI call `getArtifactBundle`).
5. `cc295ce` Codex round 1 fix: the `0009` fallback no longer references the outer row in a
   correlated subquery's `ORDER BY`.
6. Follow-up issue #260 (display of the format in the list and header, `sameLatestContent`).

## Verification

- Red first: before the fix, 14 tests failed, among them the revert case
  (`style` and `style-2` expected 1 possible duplicate each, received 0), the migration test and
  both query-plan tests.
- Query plan of the grouped statement: before (main) `SCAN a USING INDEX artifacts_type_name_idx`
  + `SEARCH l USING INDEX artifact_versions_artifact_version_unique` + a correlated scalar
  subquery + `USE TEMP B-TREE FOR GROUP BY`; after, exactly
  `SEARCH artifacts USING COVERING INDEX artifacts_format_name_idx (format=?)`. Detail lookup:
  `SEARCH artifacts USING INDEX artifacts_format_name_idx (format=? AND name=?)`.
- Full gate after the last code change: `pnpm format:check`, `lint`, `typecheck`, `test` (all
  packages 100% coverage; database 377 tests), `build`, `verify:pack`, `test:e2e` (191 passed,
  port 4403), `test:storybook` (342 passed): all exit 0.
- Database tests also pass on Node 22.23.2 (SQLite 3.51.3); before the round 1 fix every database
  test failed there with `no such column: artifacts.type`.
- Real app (data dir `/var/tmp/issue-246-real`, port 4402): with the `main` CLI, repo-a cursor rule
  v1 → skill v2 → back to v1, plus repo-b (another cursor rule `style`) and repo-c (a skill
  `style`): no "Possible duplicate" anywhere (bug reproduced). Stopped, started the branch CLI on
  the same data directory: migration `0009` applied, `format` backfilled (`style` and `style-2`
  `cursor-rule`, `style-3` `skill-md`), `updated_at` unchanged; the list shows the Badge on
  `style` and `style-2` only, and `style`'s page lists `style-2` in the card ("Different
  content"), in light and dark themes (screenshots). Rescans changed nothing; turning repo-a into
  the skill again moved `style` into `style-3`'s group. The upgrade of the `main` database
  copy was repeated with the final SQL on Node 22.23.2 and 24.21.0: same result.
- Codex adversarial review: round 1 needs-attention (the SQLite compatibility finding, fixed);
  rounds 2 and 3 (after the merge with `main`) approve.
- `om-auto-review-pr 259 --autofix` (COMMENT only): merged `origin/main` (conflict in
  `.ai/lessons.md`, both entries kept), fixed one doc nit, no blocker or major; the full gate
  passed again after the merge (`test:e2e` 199 passed, `test:storybook` 342 passed). Review:
  https://github.com/MetaX5/DirectiveBench/pull/259#pullrequestreview-5941418053

Not verified: Node 22.16.0 itself (the oldest installed was 22.22.1, SQLite 3.46.1, older than
22.16's 3.49.1); Windows; a hosted (GitHub) repository in the real-app run (covered by the
unchanged hosted tests of `refreshSourceFields`); 320px screenshots (no layout change).

## Problems and deviations

- The first `0009` backfill passed on Node 24 (CI's version) and failed on every Node 22 SQLite;
  found by Codex, fixed and recorded as a lesson.
- The issue 66 migration test called `refreshSourceFields` on a `0007` database; it now applies the
  later migrations first, since the refresh reads `artifacts.format`.
- `ArtifactBundle.folderName` stays optional (see Decisions).

## Lessons recorded

- [Run migration SQL on the SQLite of the oldest supported Node](../lessons/2026-11-17-run-migration-sql-on-the-oldest-supported-sqlite.md)

## Follow-ups

- #260: the list Format column and the page header show the latest version's format;
  `sameLatestContent` compares latest versions.
- Making `ArtifactBundle.folderName` required (PR #256 follow-up, remaining part).
- Consider a CI job on the oldest supported Node (22.16) for `packages/database`.
