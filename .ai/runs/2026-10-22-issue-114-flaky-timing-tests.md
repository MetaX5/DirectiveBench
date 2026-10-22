---
title: One shared linear-time helper and named timeouts for the flaky timing tests (issue #114)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: coordinator brief for issue #114 (flaky timing tests on the 2-core CI runner)
status: completed
branch: fix/issue-114-flaky-timing-tests
specs: [SPEC-012, SPEC-014]
---

# Run: Flaky timing tests on the 2-core CI runner (issue #114)

## Objective

Make the timing-based tests that fail intermittently on the 2-core GitHub runner pass 20 times
in a row under `taskset -c 0,1` with parallel load, with one shared helper for every linear-time
ratio test, following the timing lessons
(`.ai/lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md`). Test-only change; no
production code.

## Plan

1. Inventory every timing-based test and the CI failures behind the issue (`gh run view
   --log-failed`, including the first attempts of rerun runs).
2. Build one helper (`test-support/linear-time.ts`), self-test it red-first against a quadratic.
3. Move every ratio test the brief allows onto it; give tests that only need time a named
   timeout.
4. Prove stability (20 iterations under load) and compare with `origin/main` under the same load.
5. Gate, PR, Codex adversarial review.

Re-planned once: the first helper (wall-clock samples) failed the stability run (see Problems).

## Inventory (CI evidence from 2026-10-22 runs)

| Test | CI failure | Action |
| --- | --- | --- |
| web `parses pathological input in linear time` | `220 < 110`, `176 < 99` (raw ratio + 50 ms) | helper |
| web wide-table test (fixed 1 s bound on one parse) | not seen; same pattern | helper (columns and rows both grow) |
| agent-adapters `import-tokens` linear | 12.2, 13.0, 16.9 against 12; 5 s timeouts | helper |
| agent-adapters `workspace-inspection` linear scan | 5 s timeouts | helper |
| agent-adapters `stream-parser` linear | 5 s timeout (before its 60 s timeout) | **not changed** — file outside this brief (issue #117 owns `test/claude-code/` except two files) |
| benchmark-engine `markdown.test.ts` 27 linear shapes | 10.6 against 10 (older version) | helper (its `ratio` was the template) |
| benchmark-engine document-assertions 2 MiB (5 s bound, NFR-118-02) and adversarial deadline | 1.17 s against an older 1 s bound | kept: bound ~4× a loaded run, orders below a superlinear scan |
| database `never lets an outside statement join…` | `Test timed out in 5000ms` | named timeout (both offset sweeps) |
| runner `hosted-git` blob-fetch | `timeout` instead of `git-failed` (fixed on main by 875fb32); **still** `Test timed out in 5000ms` under load on main (reproduced here) | named timeout on the fake-git `describe` |
| core `artifacts`/`redact` 1 MiB / 10 MiB single-size bounds | none | kept: ms vs minutes |
| process/worker deadline tests (`commands`, `engine`, `orchestrator`, `pattern-worker`, `process-group`, `claude-code/process`) | none for these (related: #75) | kept: they measure real process deadlines; lower bounds only or seconds of margin; injecting a clock would need production changes |

## Decisions

- **Helper location: `test-support/linear-time.ts` at the repository root**, next to
  `vitest.shared.ts`, which every package's vitest config already imports by relative path. Test
  files import it by relative path; no package gains a dependency (runtime or workspace), nothing
  ships it (not in any `src`, `files` or bundle), no dependency-direction rule applies because it
  is not a package, and no new npm dependency (it uses `vitest`, `node:v8`, `node:vm`). A test-only
  export of a package was rejected: `apps/web` and `core` would have to depend on, say,
  `benchmark-engine`. Its self-test lives in `packages/core/test/linear-time.test.ts`, the package
  at the root of the dependency graph. `benchmark-engine/test/helpers.ts` re-exports its
  `collectGarbage` instead of keeping a copy.
- **CPU time, not wall-clock time** (`process.cpuUsage()`, user + system), after the first
  version failed under load (see Problems).
- Normalised ratio against a linear baseline on the same inputs, 8× size step, bound 4, one GC
  after building the inputs, one discarded warm-up round, fastest of 3 interleaved rounds, ≥ 20 ms
  CPU per sample (short calls repeated), named 60 s timeout. The baseline is explicit per call
  (`textBaseline` for text; the workspace test reads and splits every file).
- Tests that assert outcomes but do real work (database offset sweeps, fake-git spawns) get a
  named timeout rather than an injected clock: they assert ordering and outcomes, not time.
- `stream-parser.test.ts` left alone per the brief's file ownership; it already has a named 60 s
  timeout and a raw bound of 30 against a quadratic ~64, so it is low risk (follow-up).

## Work performed

1. `e16a540` test: shared linear-time helper + red-first self-test.
2. `2b52f41` test: web markdown (both timing tests), benchmark-engine markdown, import-tokens and
   workspace-inspection onto the helper.
3. `1f3bafc` test(database,runner): named timeouts for the offset sweeps and the fake-git tests.
4. docs: lesson update, run log.

## Verification

Stability script (scratchpad `stability.sh`): two `taskset -c 0,1 yes > /dev/null` processes,
then per iteration one `taskset -c 0,1 npx vitest run <files> --coverage.enabled=false` per package
started concurrently (web markdown; agent-adapters import-tokens + workspace-inspection +
stream-parser; database client; runner hosted-git; benchmark-engine markdown +
document-assertions; core linear-time). `yes` killed by PID afterwards.

| Run | Result |
| --- | --- |
| `origin/main`, 10 iterations | **2 failing package runs**: web linear test `78.5 < 74.3`; runner hosted-git `Test timed out in 5000ms` |
| first helper (wall-clock samples), 16 iterations | 6 failures: self-test quadratic measured 1.98/2.75/3.70; import-tokens `@@@@` 4.95; web backtick runs 4.21 |
| final helper, 20 iterations (before the hosted-git timeout) | 0 failures / 120 package runs |
| final branch, 20 iterations | **0 failures / 120 package runs** |
| `taskset -c 0,1 pnpm test --force` (with coverage) under 2× `yes`, twice | 7/7 tasks, both runs |
| Red-first: self-test quadratic `countSpacePairs` | ratio ~8 (6.7–10.6 under load; committed test asserts > 4 and that `expectLinearTime` rejects) |
| Red-first: pre-#56 padded table (rows padded to header width) under load | 22.5 / 19.9 / 20.7 (fixed parser 1.17 / 1.52 / 1.25), bound 4 |
| Probe under load (4 concurrent processes + 2× `yes`), final helper | linear 0.8–1.2, quadratic 6.3–10.6 |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | all pass, 100 % coverage |

Cost: benchmark-engine `markdown.test.ts` 14.3 s → 20.1 s, web `markdown.test.ts` +4 s (4 cores,
unloaded).

Not verified: the GitHub runner itself beyond this PR's CI runs; macOS/Windows `process.cpuUsage`
granularity (Linux only here).

## Problems and deviations

- The first helper sampled wall-clock time (fastest of three, GC before each sample, ≥ 10 ms per
  sample). Under the load script a deliberately quadratic function measured 2.0–3.7 and linear
  scanners up to 4.95: the scheduler takes whole time slices away from a sample, unevenly.
  Switching to CPU time fixed it, but a GC before each sample still inflated the next short
  sample (background sweeping is billed to the process; quadratic ~3), and the first ratio of a
  process ran before the JIT had optimised the code (quadratic ~2.5–4.4). Final version: one GC
  after building inputs, one discarded warm-up round.
- `hosted-git` was not fully fixed on main: the blob-fetch test still hit vitest's 5 s timeout
  under load (reproduced on `origin/main`).
- One unloaded `pnpm test --force` run (cores 4–19, while the `origin/main` stability run used
  cores 0–1) failed `claude-code/process.test.ts` "AC-10 … within 10 s" and
  `claude-code/stream-parser.test.ts` "rejects over-long call ids"; both passed on every rerun
  (alone and in the full suite, twice under load). The failure messages were cut off by my filter.
  Both files are outside this brief (issue #117) — follow-up.
- Stopping the first stability run with `pkill -f stability.sh` killed my own shell (known
  lesson 2026-10-14); later runs were left to finish, and the script kills only its own `yes`
  PIDs.

## Lessons recorded

- Updated `.ai/lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md` and its index
  entry: use the shared helper, measure CPU time, one GC after building inputs, warm-up round,
  prove a ratio helper both ways under load, named timeouts for heavy outcome tests.

## Follow-ups

- Move `claude-code/stream-parser.test.ts` "is linear in the stream size" onto the helper once
  issue #117 no longer owns the file.
- Investigate the one-off `claude-code/process.test.ts` AC-10 and `stream-parser` over-long ids
  failures (likely 5 s default timeout on an 8 MiB parse under coverage).
