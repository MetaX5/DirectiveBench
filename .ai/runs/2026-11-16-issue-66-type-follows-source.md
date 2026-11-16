---
title: Issue 66, an artifact's type follows its source and slugs stay immutable handles
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request to implement issue #66 after approving every decision (N1-N9, Q1-Q8)
status: completed
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

1. Plan in this log, reviewed by Codex (above); red-first tests, then the implementation.
2. Commits on `feat/issue-66-type-follows-source` (PR #247):
   - `docs(specs)`: SPEC-103 FR-103-16, §14 cases 1 to 11, §16, §20; SPEC-101 §8.2, §8.3, §14,
     §15, §20; SPEC-105 FR-105-09, FR-105-13; SPEC-118 FR-118-22, FR-118-25, §20.
   - `feat(core)`: `ARTIFACT_FORMAT_TYPES`, used by `classifyArtifactPath`.
   - `feat(database)`: `refreshSourceFields` writes `type` from the chosen version's format (also
     when the name cannot be parsed), `importArtifactVersion` sets `type`, `getArtifactBundle`
     takes the version's type; data-only migration `0007_artifact_type_follows_source`
     (drizzle-kit `generate --custom`, hand-written `UPDATE … FROM` with `row_number()`);
     `source-changes.test.ts` (16) and the `0007` test in `client.test.ts`.
   - `feat(cli)`: `candidateLabel` (Q5) and `benchmark init` scaffolding the latest version's
     type.
   - `test`: runner tests for `local-git`, `local-directory`, `github`; e2e
     `identity.spec.ts` "renames and type changes keep the URL (issue 66)".
   - `fix(cli)`: escape control and format characters in the candidate name (Codex round 1).
   - `docs(lessons)`: Playwright browser garbage collection.
3. Follow-up issue #246 (possible-duplicate grouping after a revert), labels `enhancement`,
   `priority-low`, `risk-low`.
4. Browser QA evidence on `qa-evidence-pr-247`, posted on the PR.

## Verification

Red first (new tests against the old `src`):

- database `source-changes.test.ts` + `client.test.ts`: 9 failed (7 type tests, the 0007
  migration test, the migration count); the 9 rename/slug pins passed, as intended.
- core `artifacts.test.ts`: 1 failed (`ARTIFACT_FORMAT_TYPES` missing).
- cli: 4 failed (`init` wrote `['skill']` instead of `['instruction']`, `candidateLabel`, the
  rename run, the type gate); the Codex round 1 escape test failed on `f502586`'s label.
- runner: 3 failed (`type` stayed `instruction`) for local-git, local-directory and github.

Gate (every pnpm command with `TMPDIR` under a unique `/var/tmp` directory, removed after):

| Command | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass on `54d3ac6` |
| `pnpm test --force` | pass on `54d3ac6`, 100% in all 7 packages (database 344, runner 308, CLI 207, core 321, web 589, engine 518, adapters 365) |
| `pnpm build`, `pnpm verify:pack` | pass on `54d3ac6` |
| `pnpm test:e2e` | 181 passed on `af95025` (only the CLI label changed after it) |
| `pnpm test:storybook` | 326 passed on `af95025` |

Real app (built `apps/cli/dist/cli.js`, mock agent only, data under `/var/tmp`, removed):

- Migration on a copied database: `directivebench demo`, then the `0007` journal row deleted
  and the demo artifact's type set to `rule` (a 0006 database with a stale type); `init` on a
  copy applied 1 migration, the type became `skill` again, 8 migrations recorded.
- `test-env-up.sh` on port 4402: a fixture repository registered and scanned through the UI;
  `docs/AGENTS.md` replaced by `docs/AGENTS.md/SKILL.md` and a skill renamed in place;
  rescan "(0 new, 2 new versions)"; same ids and URLs; header, Type cell and `?type=` filter
  follow; Versions tab shows both formats; keyboard-only filter works; 320px no horizontal
  scroll in both themes; no console or page errors.
- CLI against that data with a fake `claude` (no session started): plan line
  `Candidate:  review-notes (named code-review-notes) v2`; `benchmark init` scaffolds
  `[skill]` for the type-changed artifact; an `instruction` suite refuses its latest version and
  accepts `--artifact-version 1`.

Reviews: Codex adversarial review round 1 `needs-attention` (terminal controls in the candidate
name, fixed with a regression test), round 2 **approve**; `om-auto-review-pr 247 --autofix`
approve (comment review, own PR) with one nit (an over-long JSDoc line), fixed in the final
commit; label `risk-medium` raised to `risk-high` because of the data migration.

Not verified: a real github.com remote (the runner test uses a local bare remote), Windows and
macOS locally (CI runs macOS unit tests), a database created by a released version (the
migration was proved on a demo database with its `0007` row removed).

## Problems and deviations

- **`/tmp` ran out of inodes** after the first targeted e2e run (no shell could start until it
  freed when processes ended). Not reproduced afterwards: with `TMPDIR` under `/var/tmp` for
  every pnpm command, `/tmp` used inodes peaked at about 67 000 for unit tests, build,
  `verify:pack` and Storybook, but rose to about 106 000 during `pnpm test:e2e` although
  `TMPDIR` pointed at `/var/tmp`, so the browser run writes to `/tmp` by some other route. The
  1 million inodes of the first failure were not attributed to a step; the earlier commands of
  this run (runner, CLI and database Vitest runs, `pnpm build`) used the default `/tmp`.
- **Playwright's Chromium 1254 disappeared** from `~/.cache/ms-playwright` between two e2e runs
  (an unrelated project's `playwright install` garbage-collected it); reinstalled from the
  worktree with `TMPDIR` under `/var/tmp` (lesson below).
- The work was not driven through `om-auto-create-pr`: the plan, implementation and first
  verification were done by hand before the run stopped on `/tmp`, and the resumed run opened
  the PR in the house layout directly. `om-auto-review-pr` ran as briefed.
- No deviation from an approved decision. Two readings recorded under Decisions (Q5 compares
  `slugify(name)`; `benchmark init` scaffolds the latest version's type).

## Lessons recorded

- [2026-11-16 Playwright install elsewhere removes unlinked browsers](../lessons/2026-11-16-playwright-install-elsewhere-removes-unlinked-browsers.md)

## Follow-ups

- #245: install name of a nameless skill (Q7), out of scope.
- #246: possible duplicates disagree after a revert to a version of another format (Codex plan
  review finding 1).
