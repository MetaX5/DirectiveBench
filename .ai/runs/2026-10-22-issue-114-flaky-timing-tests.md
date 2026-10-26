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
3. Move every ratio test onto it; give tests that only need time a named timeout.
4. Prove stability (20 iterations under load) and compare with `origin/main` under the same load.
5. Gate, PR, Codex adversarial review (up to three rounds).

Re-planned three times, each from evidence: the wall-clock helper failed the load run; Codex
round 1 showed an 8× step cannot see N^1.5; the full gate showed the text baseline's fixed cost
(see Problems).

Paused 2026-10-22 at the maintainer's request (the coordinator committed the work in progress as
`aeebdd3`); resumed 2026-10-26 after #118, #119 and #125 merged.

## Inventory (CI evidence from 2026-10-22 runs)

| Test | CI failure | Action |
| --- | --- | --- |
| web `parses pathological input in linear time` | `220 < 110`, `176 < 99` (raw ratio + 50 ms) | helper |
| web wide-table test (fixed 1 s bound on one parse) | not seen; same pattern | helper (columns and rows both grow) |
| agent-adapters `import-tokens` linear | 12.2, 13.0, 16.9 against 12; 5 s timeouts | helper; cut at the scanner's own candidate limit |
| agent-adapters `workspace-inspection` linear scan | 5 s timeouts | helper (asynchronous: process clock) |
| agent-adapters `stream-parser` linear | 5 s timeout (before its 60 s timeout) | helper, after #119 merged (baseline: split and `JSON.parse` every line) |
| benchmark-engine `markdown.test.ts` 27 linear shapes + literal/number | 10.6 against 10 (older version) | helper (its `ratio` was the template) |
| benchmark-engine document-assertions 2 MiB (5 s bound, NFR-118-02) and adversarial deadline | 1.17 s against an older 1 s bound | kept: bound ~4× a loaded run, orders below a superlinear scan |
| database `never lets an outside statement join…` | `Test timed out in 5000ms` | named timeout (both offset sweeps) |
| runner `hosted-git` blob-fetch | `timeout` instead of `git-failed` (fixed on main by 875fb32); **still** `Test timed out in 5000ms` under load on main (reproduced here) | named timeout on the fake-git `describe` |
| core `artifacts`/`redact` 1 MiB / 10 MiB single-size bounds | none | kept: ms vs minutes |
| process/worker deadline tests (`commands`, `engine`, `orchestrator`, `pattern-worker`, `process-group`, `claude-code/process`) | none for these (related: #75) | kept: real process deadlines, lower bounds or seconds of margin; a clock would need production changes |
| #119 `claude-code/adapter.test.ts`, `benchmark-engine/test/claude-code-adapter.test.ts`; #118 `apps/cli/test/benchmark-*.test.ts` | none | no ratio tests; heavy tests already carry 60 s timeouts; added to the load script, all passed |

## Decisions

- **Helper location: `test-support/linear-time.ts` at the repository root**, next to
  `vitest.shared.ts`, which every package's vitest config already imports by relative path. Test
  files import it by relative path; no package gains a dependency (runtime or workspace), nothing
  ships it, no dependency-direction rule applies because it is not a package, and no new npm
  dependency. A test-only export of a package was rejected: `apps/web` and `core` would have to
  depend on, say, `benchmark-engine`. Its self-test lives in
  `packages/core/test/linear-time.test.ts`. `benchmark-engine/test/helpers.ts` re-exports its
  `collectGarbage`. `turbo.json` lists `test-support/**` and `vitest.shared.ts` as `test` and
  `typecheck` inputs, so a helper-only change re-runs every consumer (Codex round 3).
- **Measurement** (each point from a failure, see Problems): normalised ratio against a linear
  baseline on the same inputs; 32× size step with `size` naming the large input (the size the
  tests used before); bound 3.5; CPU time, the test thread's (`process.threadCpuUsage`, Node.js
  ≥ 23.9, else process-wide) for synchronous code and the process's for asynchronous code; calls
  in doubling batches with one clock read per batch; one GC after building the inputs; one
  discarded warm-up round; fastest of 3 interleaved rounds; ≥ 20 ms CPU per sample; named 60 s
  timeout.
- `textBaseline` = one pass over every character plus split and collapse: the pass grows with
  short inputs, split and collapse allocate like a parser.
- Tests that assert outcomes but do real work (database offset sweeps, fake-git spawns) get a
  named timeout rather than an injected clock: they assert ordering and outcomes, not time.
- Bounded work passes: shapes whose work the code bounds itself (import scan at its candidate
  limit, `parseFirstNumber` returning the first number) measure near 0, which is correct for "no
  worse than linear".

## Work performed

1. `e16a540` shared helper + red-first self-test; `2b52f41` web, benchmark-engine, import-tokens
   and workspace-inspection onto it; `1f3bafc` named timeouts (database, runner); lesson and run
   log.
2. `89d255d` Codex round 1: 32× step, thread CPU time, doubling batches, N^1.5 control.
3. `f2d6329`, `b22239e` merges of `origin/main` (#119; then #118, #125), no conflicts; `aeebdd3`
   stream-parser onto the helper.
4. `6869a2b` Codex round 2: process clock for asynchronous code, thread-pool control.
5. `789cba0` Codex round 3: Turbo cache inputs.
6. `8412dbf` text baseline with a per-character pass; import-tokens cut at the scanner's limit.
7. CI on the docs-only `4a9ff91` failed runner coverage (`hosted-git.ts` line 822, 99.86 %): the
   test "fails reading blobs…" gave every case a 200 ms read timeout, so a slowly started fake
   turned the exit-128 case into a timeout that still passed `ok: false`. Fixed red-first: short
   timeout only for the timeout case, each case's code asserted.
8. CI on `08272fb` then failed runner coverage at line 781 (the fetch's timeout branch): in the
   blob-fetch test the fetch-timeout case shortened `read` and `fetch` to 200 ms, so a slowly
   started `cat-file` fake timed out first and the case still returned `timeout`. Each timeout
   case now shortens only its own step and asserts which step timed out.

## Verification

Load script (scratchpad `stability.sh`): two `taskset -c 0,1 yes > /dev/null` processes, then per
iteration one `taskset -c 0,1 npx vitest run <files> --coverage.enabled=false` per package started
concurrently: web markdown; agent-adapters import-tokens, workspace-inspection, stream-parser,
process, adapter; database client; runner hosted-git; benchmark-engine markdown,
document-assertions, claude-code-adapter; core linear-time; cli benchmark-run (the last four
targets from 2026-10-26). `yes` killed by PID afterwards; full output kept per package and
iteration.

| Run | Result |
| --- | --- |
| `origin/main` (2026-10-22), 10 iterations | **2 failing package runs**: web linear test `78.5 < 74.3`; runner hosted-git `Test timed out in 5000ms` |
| first helper (wall-clock samples), 16 iterations | 6 failures: quadratic self-test 1.98 / 2.75 / 3.70; import-tokens `@@@@` 4.95; web backtick runs 4.21 |
| 8× helper, 2 × 20 iterations (2026-10-22) | 0 / 120 and 0 / 120 |
| 32× helper after round 1, 20 iterations (2026-10-22) | 0 / 120 |
| merged head `b22239e`, 20 iterations (7 targets) | 0 / 140 — incl. `process.test.ts` AC-10 and "rejects over-long call ids" |
| `taskset -c 0,1 pnpm test --force` under 2× `yes` at `b22239e`, three times | 7/7 tasks each |
| full gate at `789cba0` (cores 4–19) | **failed**: web backtick-runs shape `3.60 < 3.5` → baseline fix `8412dbf` |
| full gate at `8412dbf`: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test --force` | pass, 100 % coverage in all 7 packages |
| **`8412dbf`, 20 iterations (7 targets)** | **0 / 140** |
| `taskset -c 0,1 pnpm test --force` under 2× `yes` at `8412dbf`, three times | 7/7 tasks each (coverage on) |
| Calibration under load at `8412dbf` (every ratio logged, twice) | linear shapes ≤ 1.28; N^1.5 control 5.63 / 5.86; quadratic 30–36; thread-pool size² control 31.1 / 33.5 |
| Red first, round 1: N^1.5 control at 8× | 2.63–3.01 (passes bound 4); at 32×: 5.5–6.4 |
| Red first, round 2: sparse-file `readv` of size² bytes | thread clock 2.33 (passes 3.5); process clock 37.3 |
| Red first, round 3: helper-only edit, `turbo run test typecheck --dry=json` | 0 of 14 task hashes changed; with the inputs: 14 of 14 (also for `vitest.shared.ts`) |
| Red first: "fails reading blobs…" with a 1 ms read timeout (simulated slow fake start) | old test 45/45 green with lines 821–835 uncovered; new test fails (`timeout` ≠ `git-failed`) |
| Red first: fetch-timeout case with a 1 ms `read` (simulated slow `cat-file`) | new test fails: `git cat-file did not finish…` instead of `git fetch…` |
| `hosted-git.test.ts` with coverage, 20 loaded iterations after both fixes | 20 / 20 green, lines 781 and 822 covered every time |
| full runner suite with the 100 % threshold under load, five times | 5 / 5 green (234 tests) |
| Red first: pre-#56 padded table under load | 22.5 / 19.9 / 20.7 (fixed parser 1.17 / 1.52 / 1.25) |

The two one-off failures seen on 2026-10-22 (`process.test.ts` AC-10, "rejects over-long call
ids") did **not** reproduce: 0 failures in 20 loaded iterations of their files and in three loaded
full runs; unloaded they take 5.1 s (5 s grace in a 10 s bound, 30 s timeout) and 65 ms. Their
original messages were lost to my log filter. No fix made.

Not verified: the GitHub runner beyond this PR's CI runs; macOS and Windows (`threadCpuUsage`
absent before Node.js 23.9 falls back to process CPU time, untested here).

## Problems and deviations

- Wall-clock samples (fastest of three, GC before each, ≥ 10 ms) measured a quadratic at 2.0–3.7
  and linear scanners up to 4.95 under load: the scheduler takes time slices away unevenly.
- Process-wide CPU time bills V8's helper threads, whose work follows vitest's heap: a linear
  Markdown shape measured 3.9–15.6 although flat in plain Node.js. Reading the clock after every
  call (~1 µs) inflated small baselines. A GC before each sample and an unoptimised first round
  added noise. Fixed by thread CPU time, batches, one GC and a warm-up round.
- Codex round 1: N^1.5 passes an 8× step. A 32× step with the same large inputs fixed it at the
  same cost; small inputs quartered from the round-1 sizes first looked too noisy, which turned
  out to be the per-call clock read and helper threads above.
- Codex round 2: the thread clock does not see libuv's thread pool → process clock for
  asynchronous code. The first two thread-pool controls were caught anyway through main-thread
  work per call; the committed one keeps the main thread's work constant.
- Codex round 3: Turbo replayed cached consumer tests after a helper-only change.
- Full gate after round 3: split and collapse cost ~1 µs per call whatever the input, so on short
  backtick-run inputs the baseline grew 7.6× for 31× and a linear parser measured 3.6. A pure
  per-character baseline then let an allocation-heavy 3.8 MB line reach 3.36; the baseline now
  does both.
- `@/*` makes `importCandidates` yield a quadratic number of candidates (1.8 M at 6 000 chars,
  86 M at 192 000); production stops at `WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES` (100 000), so the
  work is bounded. Not changed (production code); follow-up to confirm per-candidate cost is O(1).
- `pgrep -f`/`pkill -f` with a pattern from my own command line killed my shell twice (known
  lesson 2026-10-14); two leftover vitest processes were left to finish on their own.

## Lessons recorded

- Updated `.ai/lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md` and its index
  entry.

## Follow-ups

- `importCandidates` on `@/*`: quadratic candidate count, bounded by the scanner's limit; check
  the per-candidate cost.
- `parseFirstNumber` linear test measures bounded work (first number returned at once); an input
  whose first number is long would exercise growth.
