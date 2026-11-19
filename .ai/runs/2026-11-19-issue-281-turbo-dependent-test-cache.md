---
title: Key the turbo test cache on workspace dependencies (issue 281)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #281, maintainer request
status: in-progress
branch: fix/issue-281-turbo-dependent-test-cache
specs: [SPEC-004, SPEC-012]
---

# Run: Key the turbo test cache on workspace dependencies (issue 281)

## Objective

`pnpm test` (`turbo run test`) replayed the cached result of a package after a source change in
one of its workspace dependencies (found in PR #277, 9 hidden `apps/cli` failures). Done when a
source change in any workspace package invalidates the cached `test` (and `typecheck`) result of
every package that depends on it, an unrelated package still hits the cache, and `pnpm test` does
no extra work.

## Plan

1. Reproduce on `main`: warm the cache, change one line in `packages/agent-adapters/src`, run
   `pnpm test` twice and record the `cache hit` lines; check `typecheck` the same way.
2. Pick the smallest documented turbo 2.11 option and apply it to `turbo.json`.
3. Repeat the experiment after the fix, plus `--dry=json` checks for a change in `core` and in
   `database`; compare a forced full run's time before and after.
4. Update the lesson and SPEC-004 (the only spec describing turbo task wiring); full gate.

## Decisions

- **Transit node, not `^test`, `^typecheck` or `^build`.** A `transit` task with
  `"dependsOn": ["^transit"]` and `test` with `"dependsOn": ["transit"]` is Turborepo's documented
  pattern for "depend on the dependencies' sources but run in parallel". No package has a
  `transit` script, so turbo executes nothing for it, but its hash covers the package's files
  (default inputs) and, through `^transit`, every transitive workspace dependency's.
  - `^test` would serialise the packages' tests (core, then adapters, then engine, ...), make a
    dependency's test failure block dependents, and lengthen the critical path.
  - `^typecheck` would run `tsc` (and `next typegen`) before the unit tests: needless work for
    `pnpm test`, and CI runs typecheck in a separate job anyway.
  - `^build`: only `apps/web` and `apps/cli` have build scripts; it would force a full Next.js
    build before unit tests.
  - Adding the dependencies' paths to `test.inputs` would have to list every dependency per
    package by hand and drift when dependencies change.
- **`typecheck` unchanged.** It already has `"dependsOn": ["^typecheck"]`; the experiment showed
  every dependent miss after a dependency change.
- The `transit` task keeps turbo's default inputs, so a change to a dependency's test file also
  re-runs dependents' tests. Narrowing it to `src/**` would save a little and risk missing a
  dependency's non-`src` file that dependents read (fixtures, `package.json` exports).

## Work performed

- `turbo.json`: added the `transit` task and `"dependsOn": ["transit"]` on `test`.
- Lesson `2026-11-19-turbo-replays-dependent-package-tests.md` and its index line: the gap is
  fixed, how, and how to check a new cross-package task.
- SPEC-004 §1 Turborepo row and Implementation status.

## Verification

See the PR description for the full command/result table. Summary:

- Red on `main` (turbo 2.11.11): after a one-line comment in
  `packages/agent-adapters/src/index.ts`, run 1 showed `cache miss` only for `agent-adapters` and
  `cache hit` for `benchmark-engine`, `runner`, `web`, `directivebench` (and `core`, `database`);
  run 2 was `FULL TURBO`. `typecheck` (`--dry=json`) already missed every dependent.
- After the fix: the reverted change and a second one-line change each re-ran `agent-adapters`,
  `benchmark-engine`, `runner`, `web`, `directivebench` and replayed `core` and `database`
  (`Cached: 2 cached, 7 total`); the next run was `FULL TURBO`. `--dry=json`: a `core` change
  misses all 7, a `database` change misses `database`, `runner`, `web`, `directivebench` only.
- Real `pnpm typecheck` after the change: the same five misses, `core` and `database` hit.

## Problems and deviations

None.

## Lessons recorded

- Updated [`lessons/2026-11-19-turbo-replays-dependent-package-tests.md`](../lessons/2026-11-19-turbo-replays-dependent-package-tests.md).

## Follow-ups

None.
