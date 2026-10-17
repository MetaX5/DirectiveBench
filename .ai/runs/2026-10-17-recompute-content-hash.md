---
title: Recompute the artifact manifest hash inside importArtifactVersion
date: 2026-10-17
agent: Claude Code / claude-opus-5-5
trigger: GitHub issue #23 (E01-S02-T01), delegated by the user's orchestrating agent
status: completed
branch: fix/23-recompute-content-hash
specs: [SPEC-103]
---

# Run: Recompute the artifact manifest hash inside importArtifactVersion

## Objective

Issue #23: `importArtifactVersion` must compute the version's `content_hash` itself with
`hashManifest` (SPEC-103 FR-103-04, §12) instead of trusting a caller-supplied value. Done when a
test passing a wrong hash stores the recomputed one and coverage stays at 100%.

## Plan

1. Remove `contentHash` from `ImportArtifactInput`; compute
   `hashManifest(input.files.map(({ path, sha256 }) => ({ path, sha256 })))` in the repository
   function and use it for dedup and insert.
2. Update callers (runner `importLocalArtifact`, database test fixtures, web action tests).
3. Regression test: a forged `contentHash` smuggled in by an untyped caller is ignored and the
   stored hash equals `hashManifest(files)`.
4. Update SPEC-103 Implementation status; quality gate; exercise via the CLI demo.

## Decisions

- **Removed** `contentHash` from `ImportArtifactInput` rather than ignoring it: the only
  production caller (runner `importLocalArtifact`) passed the loader's `hashManifest` result,
  which the repository function now computes identically, so no legitimate caller needs it.
  Workspace packages are private (BACKWARD_COMPATIBILITY.md), so this is not a contract break.
- Recompute the **manifest** hash only, as the issue and SPEC-103 §8 contract
  (`hashManifest(files.map(f => ({ path, sha256 })))`) specify. Per-file `sha256` values are still
  taken from the caller: FR-103-03 defines them over raw source bytes, while `content` is stored
  as UTF-8 text, so re-hashing `content` would diverge for non-UTF-8 text files. Recorded as a
  follow-up instead of widening scope.
- No migration or backfill: stored hashes are unchanged because the loader already used the same
  `hashManifest` over the same entries.

## Work performed

1. `packages/database/src/repositories/artifacts.ts`: compute `contentHash` with `hashManifest`
   before the transaction; use it for deduplication and insert; drop the input field.
2. Callers: `packages/runner/src/import.ts`, `packages/database/test/support/fixtures.ts`,
   `apps/web/test/actions.test.ts` no longer pass a hash.
3. Regression test in `packages/database/test/artifacts.test.ts` ("recomputes the content hash
   from the files and ignores a caller-supplied one"): a forged hash is ignored, the stored hash
   equals `hashManifest(files)`, and a reordered file list with a different forged hash
   deduplicates to the same version. `getArtifactBundle` expectation updated to the real hash.
4. SPEC-103 §20 Implementation status updated.

## Verification

- Regression test checked against the old behaviour: with the source temporarily switched back to
  the caller's hash it fails (`expected 'forged' to be '2109…'`); restored afterwards.
- `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` 7/7 tasks; `pnpm test` 7/7 tasks,
  470 tests passed, 100% lines/branches/functions/statements in every package;
  `pnpm build` pass; `pnpm verify:pack` "Packaging verification passed".
- Real run: `node apps/cli/dist/cli.js --data-dir <scratch> demo` completed (verdict improved);
  an independent script over the resulting SQLite file recomputed the manifest hash from the
  stored `files` and it matched `artifact_versions.content_hash` (per-file sha256 also matched
  the stored content for the demo artifact).
- Not verified: `pnpm test:e2e` (no UI change); behaviour against a real untrusted source (none
  is wired in yet).

## Problems and deviations

- `pnpm` was not on `PATH` in this environment; ran it via `corepack pnpm` and a scratch `pnpm`
  shim so turbo could find the binary. No repository change.

## Lessons recorded

None — nothing non-obvious came up.

## Follow-ups

- Decide whether `importArtifactVersion` should also verify each file's `sha256` against its
  stored content (needs a decision on non-UTF-8 text, see Decisions) before an untrusted source
  such as repository sync is wired in.
