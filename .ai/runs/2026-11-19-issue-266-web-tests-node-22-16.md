---
title: Web unit tests on the oldest supported Node, 22.16 (issue 266)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #266, run through om-auto-fix-issue
status: completed
branch: fix/issue-266-worker-tests-node-22-16
specs: [SPEC-012, SPEC-014, SPEC-004]
---

# Run: web unit tests on the oldest supported Node, 22.16 (issue 266)

## Objective

`pnpm --filter @directivebench/web test --coverage.enabled=false` must pass on Node 22.16.0 and
run in the CI job `oldest-node`, without lowering the 100% coverage gate on Node 24.

## Plan

1. Reproduce on a real Node 22.16.0 (downloaded into `.ai/tmp/`).
2. Make the real-thread highlight worker tests independent of native type stripping.
3. Fix any other failure found on 22.16, from evidence.
4. Add `apps/web` to the `oldest-node` test step; update SPEC-012, SPEC-014 and the technology
   stack spec; run the quality gate on Node 24 and the CI command on 22.16.

Re-planned after step 1: the issue named only the two worker tests, but on 22.16 a third test,
`markdown.test.ts` "parses pathological input in linear time", failed every run (3.5 to 4.4
against the bound 3.5), so step 3 became a measurement of the linear-time helper.

## Decisions

- **Type stripping through `test.execArgv`, gated on the feature.** `apps/web/vitest.config.ts`
  passes `--experimental-strip-types` to the test workers when `process.features.typescript` is
  falsy; worker threads inherit `process.execArgv`, so the unbuilt worker entry loads. No
  production code changes; on Node 22.18+ and 24 the list is empty. Skipping the two tests was
  the alternative in the issue; running them keeps the real-thread check on 22.16.
- **A relaxed linear-time bound only where the thread clock is missing.** Evidence for the
  `*a*a…` shape, five ratios per run: Node 24 thread clock 1.1 to 1.3, Node 24 process clock 1.1
  to 1.8, Node 22.22 thread clock 1.7 to 1.9, Node 22.22 process clock 2.5 to 6.3, Node 22.16
  (process clock, no `threadCpuUsage`) 3.5 to 4.3. Wall-clock time (0.2 to 2.9) and
  `--single-threaded-gc` (2.4 to 5.2) were tried and rejected. `expectLinearTime` now uses
  `MAX_LINEAR_RATIO_WITHOUT_THREAD_CLOCK = 12` for synchronous code when
  `process.threadCpuUsage` is missing (Node before 23.9); everything else keeps 3.5. The core
  helper test now asserts the quadratic control measures above 12, so the relaxed bound still
  fails quadratic code. This is a decision for the maintainer (see the PR).

## Work performed

1. Worktree `.ai/tmp/issue-266` on `fix/issue-266-worker-tests-node-22-16` from `origin/main`.
2. `apps/web/vitest.config.ts`: `execArgv` with `--experimental-strip-types` when needed.
3. `test-support/linear-time.ts`: `MAX_LINEAR_RATIO_WITHOUT_THREAD_CLOCK` and the bound
   selection in `expectLinearTime`; `packages/core/test/linear-time.test.ts`: quadratic control
   above the relaxed bound.
4. `.github/workflows/ci.yml`: `oldest-node` test step also filters `@directivebench/web`.
5. Specs SPEC-012 §8, SPEC-014 §9 and SPEC-004 (technology stack); lesson and index entry.

## Verification

| Command | Node | Result |
| --- | --- | --- |
| `pnpm --filter @directivebench/web test --coverage.enabled=false` on `main` (red first) | 22.16.0 | 3 failed (2 worker tests, `{ kind: 'plain', reason: 'failed' }`; markdown linear time 4.38 > 3.5) |
| same, with only the `execArgv` change | 22.16.0 | 1 failed (markdown linear time 3.57, 3.97, 4.04 in three runs) |
| same, with only the linear-time change | 22.16.0 | 2 failed (the worker tests), three runs |
| same, with both | 22.16.0 | 656 passed, three runs |
| the `oldest-node` test command (`--filter "./packages/*" --filter directivebench --filter @directivebench/web --no-bail test --coverage.enabled=false`) | 22.16.0 | core 351 (+2 skipped), agent-adapters 398 (+2 skipped), database 387, benchmark-engine 526, runner 320, cli 211, web 656: all passed |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | 24.21.0 | pass |
| `pnpm test` (100% coverage) | 24.21.0 | 7 of 7 packages pass (web 656, core 351 +2 skipped). A first run had runner coverage at 99.9% statements; the rerun of the runner and the full rerun were at 100%. The runner does not use the changed helper |
| `pnpm build`, `pnpm verify:pack` | 24.21.0 | pass ("Packaging verification passed", highlighted file served) |

Not verified locally: the `oldest-node` job on GitHub's Ubuntu runner (checked on the PR's CI);
Node versions between 22.16 and 24 other than 22.22.

## Problems and deviations

- A probe step ran `git checkout apps/web/vitest.config.ts` and silently reverted the
  `execArgv` change; the next 22.16 run showed the worker failures again and the change was
  re-applied. Probes now restore files from a copy, not from git.
- `pnpm lint` and `pnpm typecheck` through turbo need a `pnpm` binary on `PATH`; with only
  corepack, turbo fails with "Unable to find package manager binary". A corepack shim in
  `.ai/tmp/` (removed at the end) fixed it.

## Lessons recorded

- [On Node 22.16 tests lose native type stripping and the per-thread CPU clock](../lessons/2026-11-19-node-22-timing-and-type-stripping-in-tests.md)

## Follow-ups

- The runner's 99.9% coverage on one Node 24 run looks like a timing-dependent branch; not
  investigated here.
