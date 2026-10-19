---
title: Recompute per-file sha256 server-side in importArtifactVersion (issue #39)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request to fix GitHub issue #39 (om-auto-fix-issue 39 --force --no-ui)
status: completed
branch: fix/issue-39-recompute-file-sha256
specs: [SPEC-103, SPEC-102]
---

# Run: Recompute per-file sha256 server-side (issue #39)

## Objective

Close the gap left by #35: `importArtifactVersion` must not accept per-file `sha256` values from
its caller (SPEC-103 §12). Acceptance criteria from #39: recompute each file's `sha256` from the
stored content; regression test with a wrong per-file `sha256`; decide and test the non-UTF-8
case of `loadLocalArtifact`; update SPEC-103's implementation status; keep 100% coverage.

## Plan

1. Triage (`om-verify-in-repo`): confirm the defect is real and unfixed on `origin/main`.
2. Root cause (`om-root-cause`), then claim the issue and fix in an isolated worktree.
3. Regression tests in `packages/database` and `packages/core`, quality gate, PR, review loop.

## Decisions

- **Recompute, keep the input type.** `importArtifactVersion` recomputes each file's `sha256`
  and `size` from the UTF-8 encoding of its `content` and ignores the caller's values. The
  issue allows removing the fields from the input type instead. That would break the excess
  property check in `apps/web/test/actions.test.ts`, which is outside this run's scope, and the
  runtime still has to rebuild the stored objects either way. `size` is recomputed as well:
  storing a caller-supplied size next to a recomputed hash would let the two disagree.
- **Non-UTF-8: reject like the walker (SPEC-102 FR-102-17), do not hash original bytes.**
  `loadLocalArtifact` now uses the walker's `isBinary` (exported from `discovery.ts`): a NUL
  byte in the first 8 KiB or invalid UTF-8. Such supporting files are skipped with a warning,
  and a binary primary file is an error. A second option was to carry the original bytes to the
  database and hash them there. It was not taken because `StoredArtifactFile.content` is a
  string and the MVP stores text only (FR-102-17), so the database never has the original bytes.
  With valid UTF-8 the decoded content re-encodes to exactly the source bytes, so the recomputed
  hash still satisfies FR-103-03 (hash of the raw bytes).
- Side effect, intended: the loader now checks for NUL only in the first 8 KiB, as the walker
  and FR-102-17 do. A valid UTF-8 file with a NUL after 8 KiB is now stored, not skipped.
- Consequence for existing databases: re-importing an artifact whose earlier version held a
  lossily decoded non-UTF-8 supporting file, or skipped a file with a late NUL, yields a different
  manifest and therefore a new version. Bundled examples are unaffected: none of their files is
  invalid UTF-8 or contains a NUL.
- After review: `sha256`/`size` are now optional on `ImportArtifactFile` (still ignored), and
  a file path or content containing an unpaired UTF-16 surrogate is rejected (the path check
  came from the re-review). `'\uD800'` and `'\uFFFD'`
  encode to the same UTF-8 bytes, so they would otherwise share one identity. The check is a
  `/\p{Surrogate}/u` regex, because `String.prototype.isWellFormed` is not in the repository's
  `ES2023` TypeScript lib.

## Work performed

1. Triage: confirmed on `origin/main` (a64b4e9) that `artifacts.ts:79` hashes caller-supplied
   `sha256` values and the insert stores `input.files` as given. No PR or commit references #39.
2. Claimed #39 (assignee, `in-progress`, claim comment) after the maintainer-approved `--force`
   takeover from cieslinho.
3. `packages/database`: recompute file `sha256`/`size` and use them for storage, the manifest hash
   and deduplication. Fixture `artifactInput` now supplies real hashes. Regression test added.
4. `packages/core`: `isBinary` exported. `loadLocalArtifact` reads the primary file as bytes,
   rejects a binary primary file, and skips non-UTF-8 supporting files. Tests added.
5. SPEC-103 and SPEC-102 implementation status updated.
6. PR #41 opened. An independent review (subagent, `om-code-review` standards) approved it with
   minor and nit findings only. Fixed in a follow-up commit: the lone-surrogate guard and test,
   optional ignored fields, the SPEC-103 §12 invariant sentence and this run log. Declined: adding
   the `.ai/lessons.md` entry (this run may not edit that file). Follow-up: the existing
   double read of a skill's primary file. The re-review approved, with one nit: also reject a path
   that contains a lone surrogate, which was then fixed.

## Verification

- Regression tests fail without the fix: with the old `packages/database/src`, 2 tests fail
  ("recomputes the content hash …", "recomputes each file sha256 and size …"). With the old
  `packages/core/src`, the 2 new loader tests fail. All pass with the fix.
- `pnpm format:check`: pass (after running prettier on `test/support/fixtures.ts`).
- `pnpm lint`: pass. `pnpm typecheck`: pass (7/7 tasks).
- `pnpm test`: pass, 100% statements/branches/functions/lines in every package. Counts after
  the review fixes: core 119, database 62, runner 31, benchmark-engine 110, agent-adapters 34,
  web 66, cli 74.
- `pnpm build`: pass. `pnpm verify:pack`: pass (packed CLI demo and serve smoke test).
- Real path: in the SQLite database left by `verify:pack`'s demo, the stored `SKILL.md` of the
  bundled example has `sha256` equal to the sha256 of the file's bytes on disk and to the sha256
  of the UTF-8 encoding of its content. The size and the manifest hash match too.
- Not verified: repository scanning (#16) and sync (#18) do not exist yet, so the fix is
  exercised only through the local import path and direct repository-function tests.

## Problems and deviations

- None against the specs. The input type still declares `sha256` and `size`. They are documented
  as ignored rather than removed (see Decisions).

## Lessons recorded

- [lessons/2026-10-19-recompute-hashes-from-utf8-text.md](../lessons/2026-10-19-recompute-hashes-from-utf8-text.md)
  (its `.ai/lessons.md` index entry is left to the maintainer: a parallel run edits that file).

## Follow-ups

- Optional: drop `sha256`/`size` from `ImportArtifactFile` once the callers that still set them
  (`apps/web/test/actions.test.ts`, `packages/runner/src/import.ts`) are updated.
- `loadLocalArtifact` reads a skill's primary file twice: once to parse it, again in
  `collectFiles`. If the file changes between the reads, the parsed metadata can disagree with
  the stored content, or the primary file can drop out of the manifest. This predates the PR.
  Reuse the first read or assert that the primary file is in the manifest.
- Pending outside this run: the lesson's one-line entry in `.ai/lessons.md` (handed to the
  coordinator, because a parallel run edits that file).
