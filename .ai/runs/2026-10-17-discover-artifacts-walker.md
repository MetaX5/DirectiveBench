---
title: Repository tree walker discoverArtifacts (issue #24)
date: 2026-10-17
agent: Claude Code / claude-opus-5-5
trigger: coordinator request for GitHub issue #24 (E01-S02-T02, story #16)
status: completed
branch: feat/24-discover-artifacts
specs: [SPEC-102, SPEC-103, SPEC-012, SPEC-014]
---

# Run: Repository tree walker discoverArtifacts (issue #24)

## Objective

Add `discoverArtifacts` to `packages/core/src` implementing SPEC-102 FR-102-12…20 over a local
root: skipped directories, symlink policy, named limits, binary detection, deterministic output,
whole-directory skill manifests, with fixture-based tests at 100% coverage. Out of scope: wiring
into the database, runner or web app (story #16); `packages/database` untouched.

## Plan

1. Walk the root with `readdir({ withFileTypes })`, never following symlinks, skipping `.git` and
   `node_modules` at any depth; sort entries by full path with a branch-free code-unit comparator.
2. Classify every file and symlink with `classifyArtifactPath`; abort when candidates exceed the
   per-scan cap.
3. Assign each entry to its deepest enclosing skill directory, so nested skills are separate.
4. Per candidate: symlink → `symlink` error; read with `O_NOFOLLOW` and an `fstat` size bound;
   binary detection; `parseArtifactFile`; `hashManifest`. Limit violations and read failures
   become per-artifact `DiscoveryError`s; unexpected errors propagate.
5. Fixture tree per SPEC-102 §15 plus a simulated-filesystem test (listing permutations, open
   failure, unexpected parser error).

## Decisions

- Local root path instead of the §8.3 `FileTree` abstraction: there is only one tree source
  today; recorded as a deviation in SPEC-102 §20.
- `DiscoveredArtifact` adds `primaryFile` and `warnings` (like `LoadedArtifact`) to ease the
  story #16 import, which needs `primaryFile`.
- An oversized supporting file is an error for its skill (FR-102-16), so `skipped` reasons are
  only `symlink` and `binary`.
- Read errors on directories during the walk abort the scan (not swallowed).
- No exclude-glob option: it needs a glob dependency and the settings work of SPEC-104.

## Work performed

- `packages/core/src/discovery.ts` (new), exported from `packages/core/src/index.ts`.
- Tests: `packages/core/test/discovery.test.ts`, `discovery-simulated-fs.test.ts`, fixture
  builder `discovery-fixture.ts`.
- SPEC-102 §10 and §20 updated for the verified behaviour and deviations.

## Verification

- `pnpm format:check` — pass. `pnpm lint` — pass. `pnpm typecheck` — 7/7 tasks pass.
- `pnpm test` — 7/7 tasks pass, 100% statements/branches/functions/lines in every package;
  `@directivebench/core` 117 tests (9 files). Core suite repeated 5 times: identical result,
  100% branches each time.
- `pnpm build` — pass. `pnpm verify:pack` — "Packaging verification passed".
- Real run (tsx script in the scratch area, not committed) against this repository's worktree,
  three scans: 1,387 regular files, 48 artifacts (42 `.agents/skills/*/SKILL.md` with their
  supporting files, `AGENTS.md`, `CLAUDE.md`, 4 example skills incl. `apps/cli/dist` build
  copies), 0 errors; identical JSON digest on all runs; 93.6 ms cold, 35–36 ms warm.
- Synthetic tree of 50,000 files with 200 skills (NFR-102-01): 200 artifacts, 0 errors,
  183–200 ms per scan, identical digest across three runs.
- Not verified: Windows (paths are built with `/` from directory entry names; CI runs Linux);
  scanning through the UI or runner (not implemented, story #16).

## Problems and deviations

- `turbo` could not find `pnpm` in the worktree shell (only `corepack` on PATH); used a
  scratch-area shim. Environment-specific, not a repository problem.
- Deviations from SPEC-102 §8.3 are listed in §20 (local root, no exclude, extra fields).

## Lessons recorded

None (the maintainer asked to hold off on new lessons for now; nothing non-obvious was hit).

## Follow-ups

- Story #16: scan job in the runner, import via `importArtifactVersion`, UI trigger.
- FR-102-15 second half: only files tracked at the scanned commit for git repositories; until
  then untracked build output (e.g. `apps/cli/dist/examples`) is discovered.
- Exclude globs (SPEC-104) and the `FileTree` abstraction (SPEC-105).
- A directory component swapped for a symlink between walk and read is not detected
  (`O_NOFOLLOW` protects only the last component); low risk for a local scan.
