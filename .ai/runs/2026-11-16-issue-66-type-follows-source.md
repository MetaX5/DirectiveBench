---
title: Issue 66, an artifact's type follows its source and slugs stay immutable handles
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request to implement issue #66 after approving every decision (N1-N9, Q1-Q8)
status: in-progress
branch: feat/issue-66-type-follows-source
specs: [SPEC-101, SPEC-103, SPEC-105, SPEC-118, SPEC-126]
---

# Run: Issue 66, an artifact's type follows its source and slugs stay immutable handles

## Objective

Implement issue #66 as approved on 2026-11-16 (decision record: the last comment on the issue;
working copy of the full decision document outside git). Acceptance: a rescan keeps the
artifact's identity through a rename and a type change exactly as SPEC-101 §8.3 rules 1 to 4
already say; `artifacts.type` follows the format of the version the chosen active occurrence
holds (FR-126-07's choice), a run's bundle takes its type from the bundled version; slugs never
change, are never freed or reused; `/artifacts/[id]` keeps working; a data-only migration
repairs stale types in existing databases; the 11 edge cases (N9) are specified and tested.

## Plan

Approved decisions are not reopened. Step 0 is a Codex review of this plan.

1. **Core** (`packages/core/src/artifacts.ts`): add `ARTIFACT_FORMAT_TYPES: Record<ArtifactFormat,
   ArtifactType>` and `artifactTypeOf(format)`; `classifyArtifactPath` takes its types from it, so
   there is one format → type map.
2. **Database, refresh** (`refreshSourceFields`): also select `artifacts.type`; for the chosen
   active occurrence, `type = artifactTypeOf(version.format)`. The type is written even when the
   name cannot be parsed (missing primary file, occurrence path that does not classify as the
   format): the format is stored on the immutable version and needs no parse, so the refresh and
   the migration (step 4) compute the same value for every row. Name and description keep their
   existing skip. Only changed fields are written. No active occurrence: all three are kept.
3. **Database, bundle and import**: `getArtifactBundle` returns `type` from the bundled version's
   format (N2). `importArtifactVersion` sets `type` from its input together with `name` and
   `description` when it finds the artifact (N9.10); its slug-or-(name, type) lookup is unchanged.
4. **Migration `0007_artifact_type_follows_source`** (drizzle-kit `generate --custom`, data-only,
   hand-written): one `UPDATE artifacts SET type = chosen.type, updated_at = <now ISO> FROM (…)`
   where `chosen` ranks each artifact's active occurrences joined to their latest version by
   `version DESC, occurrence created_at, occurrence id` (`row_number()`), maps the format with a
   `CASE` over every `ARTIFACT_FORMATS` value, and updates only rows whose type differs. Missing
   artifacts (no active occurrence) keep their type. Down: data-only, nothing to undo (the old
   type was wrong by definition); the test deletes the journal row and re-applies to show it is
   idempotent. The existing 0006 test switches from the full folder to `partialMigrations(7)`
   (lesson 2026-10-22).
5. **CLI**: the `benchmark run` plan line becomes `Candidate:  <slug> vN (named <name>)` when
   `slugify(name) !== slug` (Q5); `benchmark init` writes `artifactTypes: [<type of the latest
   version's format>]`, the type the default candidate is gated with (FR-118-25 via N2), instead
   of `artifacts.type`. The type gate itself already reads the bundle's type, so it follows N2.
6. **Specs**: SPEC-103 FR-103-16 (new), §14 (N9.1 to N9.10 plus N9.11), §16 two criteria, §20;
   SPEC-101 §8.2 (`slug`, `type` comments), §8.3 "Identity versus source fields", §14 (N9.1,
   N9.2, N9.7, slug never reassigned), §15; SPEC-105 FR-105-09 (`type` is parser-owned),
   FR-105-13 ("never reassigned"); SPEC-118 FR-118-22 (slug never changes), FR-118-25 (version's
   type). SPEC-126 is not edited. No ADR (Q8). The specs index is updated if a spec's summary
   there changes.
7. **Tests, red first** (each recorded failing on the old code before the fix):
   - `packages/database/test/source-changes.test.ts` (new): the 11 tests of decision §3.2 plus
     N9.2, N9.3, N9.8 (hosted) and N9.11 (slug equal to another artifact's id), using the
     identity-test helpers (copied, no shared helper extraction).
   - `packages/core/test`: `artifactTypeOf` for every format agrees with `classifyArtifactPath`.
   - `packages/database/test/client.test.ts`: migration 0007 on a 0006 database with a stale
     row (b3), a correct row, a Missing row, a tie on the version number, and one stale row per
     format so the SQL `CASE` covers `ARTIFACT_FORMAT_TYPES`; re-apply after removing the
     journal row is a no-op.
   - `packages/runner/test`: a rename and a type change across two real scans for `local-git`,
     `local-directory` (`missing-occurrences.test.ts` style) and `github` (local bare remote).
   - `apps/cli/test`: `benchmark run --artifact <slug at creation>` after a rename resolves and
     prints `(named …)`; the suite type gate refuses after a type change; `benchmark init`
     scaffolds the latest version's type.
   - `apps/web/e2e/identity.spec.ts`: after an in-place rename and after a type change through
     real rescans, the same `/artifacts/[id]` URL opens with the new name / type (header Badge,
     list Type cell and type filter).
8. Quality gate, real-app proof (built CLI, `demo`, local rescans under `/var/tmp`, migration on a
   copy of a database with a stale type), browser QA on the built app (both themes, 320px),
   Codex adversarial review until approved, `om-auto-review-pr --autofix`.

### Plan review (Codex, sceptical staff engineer, read-only)

Findings and what was adopted (none changes an approved decision):

1. P2, duplicate detection keys on the current `artifacts.type` plus the latest version's
   format (`possibleDuplicateGroups`, `readPossibleDuplicates`): after instruction v1 → skill v2 →
   revert to v1 the type is `instruction` while the latest format is `skill-md`, so a same-named
   skill stops counting. **Not fixed here, follow-up issue filed:** before this change the type
   was frozen at creation, so the same mismatch existed permanently for every (b3) artifact; the
   change narrows it to a revert to an older format. Fixing it means dropping the type from the
   grouping, which loses `artifacts_type_name_idx` (NFR-126-02, pinned by a query-plan test), a
   SPEC-126 performance decision outside this issue.
2. P2, type-only refresh coverage: adopted. Tests for a stale type with a missing primary file
   and with an occurrence path that does not classify as the format, idempotence (`updated_at`
   unchanged by a second refresh), and the type reverting when the repository holding the
   highest version is removed (`removeRepository` → `refreshSourceFields`).
3. P2, migration fixtures: adopted. An active occurrence holding v1 while a newer v2 of another
   format exists (also held by a removed occurrence); the migration and the runtime refresh give
   the same type.
4. P2, historical candidates: adopted. `benchmark run --artifact-version 1` after a type change
   is gated with v1's type; `benchmark init` after a revert scaffolds the latest version's type.
5. P3: adopted. `client.test.ts` counts applied migrations (7 → 8); both 0006 test calls are
   pinned to `partialMigrations(7)`.
6. P3: adopted. Red-first applies to changed behaviour only (rename and slug tests pin existing
   behaviour); real type-change fixtures replace an `AGENTS.md` file with `AGENTS.md/SKILL.md`;
   the e2e captures the artifact id before renaming.

## Decisions

- Q5's "slug differs from the name" is read as `slugify(name) !== slug`, as the decision
  document's recommendation words it (a name `Code Review` with slug `code-review` adds nothing).
- `benchmark init` scaffolds the type of the latest version (the default candidate's bundle
  type) rather than `artifacts.type`, so a fresh scaffold is never refused by the FR-118-25 gate.

## Work performed

Uncommitted in the worktree so far (nothing pushed yet):

- core: `ARTIFACT_FORMAT_TYPES` (+ `ofFormat` in `classifyArtifactPath`), test in
  `packages/core/test/artifacts.test.ts`.
- database: `refreshSourceFields` writes `type` from the chosen version's format (also when the
  name cannot be parsed), `importArtifactVersion` sets `type`, `getArtifactBundle` takes the
  version's type; migration `0007_artifact_type_follows_source.sql` (+ journal, snapshot);
  tests `packages/database/test/source-changes.test.ts` (16) and the 0007 test in
  `client.test.ts` (count 7 → 8, 0006 test pinned to `partialMigrations(7)`).
- cli: `candidateLabel` (Q5) in `benchmark-run.ts`; `benchmark init` scaffolds the latest
  version's type; tests in `benchmark-run.test.ts` and `benchmark-init.test.ts`.
- runner: issue-66 tests in `missing-occurrences.test.ts` (local-git, local-directory) and
  `hosted-repository.test.ts` (github, local bare remote).
- web e2e: `identity.spec.ts` "renames and type changes keep the URL (issue 66)".
- Still to do: spec edits (step 6), the refresh doc comment in `artifacts.ts` needs re-wrapping
  to 100 columns, lint/typecheck/full gate, commits, PR, real-app run, QA, reviews.

## Verification

Red first (new tests against the old `src`, 2026-11-16):

- database `source-changes.test.ts` + `client.test.ts`: 9 failed (7 type tests, the 0007
  migration test, the migration count), the 9 rename/slug pins passed.
- core `artifacts.test.ts`: 1 failed (`ARTIFACT_FORMAT_TYPES` missing).
- cli: 4 failed (`init` wrote `['skill']` instead of `['instruction']`, `candidateLabel`, the
  rename run, the type gate).
- runner: 3 failed (`type` stayed `instruction`) for local-git, local-directory and github.

Green on the new code: database 344 passed with 100% coverage, core 321 passed with 100%
coverage, cli `benchmark-run`/`benchmark-init` 47 passed, runner issue-66 tests 3 passed,
`identity.spec.ts` 8 passed (after `pnpm build`, TMPDIR under `/var/tmp`).

## Problems and deviations

- The run stopped after the e2e run: `/tmp` (the volume of Claude Code's temporary directory)
  reported 0 free inodes, so no shell command could start. Not investigated (no shell).

## Lessons recorded

## Follow-ups

- #245: install name of a nameless skill (Q7), out of scope.
