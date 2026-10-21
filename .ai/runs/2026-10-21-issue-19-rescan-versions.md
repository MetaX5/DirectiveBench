---
title: A rescan creates new versions only for changed content (issue #19, E02-S01)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 19 (feature route; covering spec SPEC-103)
status: completed
branch: feat/issue-19-rescan-versions
specs: [SPEC-103, SPEC-013, SPEC-001, SPEC-105, SPEC-014]
---

# Run: A rescan creates new versions only for changed content

Source doc: .ai/specs/2026-10-14-artifact-versioning.md
Issue: #19

## Objective

Implement issue #19 (E02-S01) acceptance criteria, for the local providers (`local-git`,
`local-directory`) and the hosted `github` provider:

1. A rescan of an unchanged repository creates 0 new versions (SPEC-013 M1 AC2).
2. One edited file creates exactly 1 new version of that artifact, with the next number, and the
   earlier version is kept (M1 AC2, SPEC-103 FR-103-06/07).
3. User-assigned categories, tags and benchmark assignments survive a rescan (SPEC-001
   principle 15).
4. The artifact's version history (number, hash, date) is covered by an automated test
   (Playwright for `apps/web/app/artifacts/[id]`).

Out of scope: diffs, the "evaluated on vN, latest is vM" notice, skipping an unchanged hosted
remote via `ls-remote`.

## Plan

1. Find out what already works: #16 wrote every scanned version through `writeArtifactVersion`
   (dedup by `(artifact_id, content_hash)`, `max + 1`), and #18 reported "rescan created 0 new
   versions" for github.com.
2. Close the gaps with tests at the runner level for each provider: unchanged rescan → 0
   versions; one edited supporting file → exactly 1 new version of that artifact, earlier kept,
   other artifacts untouched; categories, tags, notes and benchmark assignments kept.
3. Playwright: register a fixture, scan, open the Versions tab (number, hash, date), edit one
   file, rescan through the UI, check v2 and v1, and that a category assignment is kept.
4. Update SPEC-103 §20 and SPEC-013 §5 for verified behaviour only.

## Decisions

- **No production change to the scan path.** Before writing code, the behaviour was exercised:
  `applyRepositoryScan` (#16) already deduplicates by `(artifact_id, content_hash)`, numbers
  `max + 1`, keeps earlier versions and never touches user-managed fields, for local and hosted
  scans alike (#18 reuses `storeScanResults`). Changing it would have been churn; #19 adds the
  missing proof per provider and in the UI instead.
- **Tooltip with the full hash on the Versions tab** (SPEC-103 §11 "full hash copyable"): the
  table showed a 16-character prefix only, so the full hash was not visible anywhere in the UI.
  Smallest reversible step: a `title` on the hash cell, plus `data-testid="versions"` for the
  test. A copy button and the "latest" badge are left for later.
- **User metadata seeded with SQL in tests.** No UI or repository function assigns tags or notes,
  or a benchmark to a scanned artifact, yet; the tests set them directly (categories and suites
  through `assignCategoriesBySlug`/`assignBenchmarkSuite` in the unit tests).

## Work performed

1. Read AGENTS.md, SDLC.md, the spec index, lessons, SPEC-103, SPEC-013 M1, SPEC-001 principle
   15, the #16/#17/#18 run logs, issue #19 and its comment; claimed the issue.
2. `packages/runner/test/support/rescan.ts`: shared helpers — per-occurrence version history,
   the expected history after one edit, user metadata assignment and read-back.
3. `repository-scan.test.ts`: one test per local provider (`local-git`, `local-directory`):
   unchanged rescan and a non-artifact edit → 0 versions and identical history; one edited
   supporting file → exactly one new version (next number, new hash) of that artifact, earlier
   kept, others unchanged; revert → 0 versions, occurrence back on v1; categories, tags, notes and
   benchmark assignment kept.
4. `hosted-repository.test.ts`: the same for `github` with the local bare-remote transport, plus
   the commit on occurrences and the new version's `source_commit_sha`.
5. `apps/web/app/artifacts/[id]/page.tsx`: full hash tooltip and test id on the Versions table.
6. `apps/web/e2e/versions.spec.ts`: register and scan through the UI, Versions tab (number, short
   hash, tooltip, file count, path, date — compared with the stored rows), unchanged rescan,
   one-file edit and rescan (v2 + v1), category, tag and benchmark suite still shown.
7. SPEC-103 §16 (two criteria ticked) and §20, SPEC-013 §5 M1 updated for verified behaviour.

## Verification

- Mutation check: making the writer reset `tags` on update fails both local rescan tests.
- `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` pass; `pnpm test` pass at 100%
  coverage (core 238, database 120, runner 193, web 144, cli 75, benchmark-engine 110,
  agent-adapters 34).
- `pnpm build` pass; `pnpm verify:pack` "Packaging verification passed"; `pnpm test:e2e` 37
  passed (1 new).
- Real app, built CLI (`node apps/cli/dist/cli.js --data-dir <tmp> serve`), driven with
  Playwright against a fresh data directory and a `local-git` fixture (skill with a supporting
  file + AGENTS.md):
  - first scan: "2 artifacts found (2 new, 2 new versions)";
  - unchanged rescan: "(0 new, 0 new versions)";
  - `references/checklist.md` edited: "(0 new, 1 new version)";
  - category `security` and tag assigned (SQL, no UI exists), rescan: "(0 new, 0 new versions)",
    Overview still shows "Security" and the tag;
  - AGENTS.md edited: "(0 new, 1 new version)" — AGENTS.md got v2, the skill stayed at v2;
  - Versions tab of the skill: `v2 f7487451adfcece3… 2 .agents/skills/real-review 21 Oct 2026,
    17:26 UTC` and `v1 84eb84cc7f9bbebc… …` (screenshot checked).

Not verified: a benchmark assignment in the real app (a fresh data directory has no suite; it
is covered by the unit tests and the Playwright test, which uses the demo suite); a real
github.com rescan in this run (#18 recorded 0 new versions on `anthropics/skills`; the hosted
rules here are tested against a local bare remote only); Windows and macOS.

## Problems and deviations

None. The acceptance criteria were already met by the #16 writer; the deviation from the plan is
that no production code in the scan path changed.

## Lessons recorded

None: no non-obvious bug or constraint was hit.

## Follow-ups

- Skip fetching and scanning a hosted repository whose remote head equals `last_commit_sha`
  (`ls-remote`, note on #19).
- A way to edit tags and notes and to assign a benchmark to a scanned artifact (SPEC-101/106);
  until then principle 15 is only exercised through repository functions and SQL.
- SPEC-103 §11 leftovers: "latest" badge, a copy button for the full hash, "first seen at
  <repo>:<path>@<sha>".
