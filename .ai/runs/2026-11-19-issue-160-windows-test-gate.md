---
title: Windows unit-test gate, first packages (issue 160)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: user request (om-auto-fix-issue 160)
status: partial
branch: fix/issue-160-windows-test-gate
specs: [SPEC-012, SPEC-102]
---

# Run: Windows unit-test gate, first packages (issue 160)

## Objective

Add a `windows-latest` unit job and fix the Windows failures at their root cause, from CI
evidence (no local Windows). Issue 160's "Done when": the job is green and required, every skip
has a reason, and repository registration and scanning work on Windows (the "git was not found"
cause is fixed or explained). The user allowed a coherent first PR with follow-up issues.

## Plan

1. Probe: add the job to `ci.yml` on a draft PR and read the full log.
2. Fix by cause, package by package, starting with the issue's priority ("git was not found").
3. Gate the packages that pass; report the rest in a non-gating step; file follow-ups.

## Decisions

- **Windows runs without the coverage threshold.** Issue 160 §3 left the choice open. POSIX-only
  branches (signals, file modes, FIFOs) cannot run on Windows, and marking each with
  `v8 ignore` would add exceptions only to pass. Linux and macOS keep enforcing 100%; this
  mirrors `oldest-node`.
- **First PR gates `core`, `database`, `benchmark-engine` and `web`;** `runner`,
  `agent-adapters` and `apps/cli` run with `continue-on-error` and are issues #301 to #303.
- **One package at a time** (`--concurrency=1`): the second probe timed out two database tests
  at 5 s beside the engine suite. Timeouts were not raised.
- **`.gitattributes`: `* text=auto eol=lf`.** Every tracked file was already LF in the index;
  this only stops `core.autocrlf` from rewriting checkouts.
- Not a required check yet (as for macOS in #159): making it one is a branch-protection
  setting for the maintainer.

## Work performed

1. `ci: probe the unit tests on windows-latest`: run 44630522356, 203 failures (core 19,
   agent-adapters 19, benchmark-engine 6, web 1, cli 31, runner 127; database passed).
2. `test: make core, engine, web and runner tests portable to Windows` (also the product fix in
   `runner/src/repository-registration.ts`):
   - runner: `findGitExecutable` falls back to `PATHEXT=.COM;.EXE` on `win32` (48 of the runner
     failures were "git was not found on PATH." from tests passing `{ PATH }` alone; the runner
     itself passes `process.env`, which has `PATHEXT`). Regression test with a stubbed platform.
     Runner tests compare paths with `realpathSync.native` (8.3 names), except
     `runner-cache-sweep.test.ts`, left to the parallel flaky-test work (#297, PR #299).
   - core: `config.test.ts` builds expected paths with `join`/`resolve`; the simulated-fs hooks
     see `/` paths; two FIFO tests and six `chmod 000` tests skip on Windows with a reason;
     `test-support/linear-time.ts` makes each sample last at least 10 ticks of the CPU clock
     (`minSampleMsOf`, with a test of a coarse and a fine clock).
   - benchmark-engine: libuv's injected Windows variables, `SIGTERM` on Windows too,
     `realpathSync.native`, and the platform's own refusal message without `O_NOFOLLOW`.
   - web: `design-tokens.test.ts` reports and matches paths with `/`.
   - `.gitattributes` keeps every checkout LF (example comparability key).
3. `ci(windows): gate core, database, engine and web; report the rest`.
4. Specs: SPEC-012 §8 and §9, SPEC-102 §20. Lesson. Follow-up issues #301, #302, #303.

## Verification

| Check | Result |
|---|---|
| Windows probe before the fixes (run 44630522356) | ❌ 203 failed in 6 packages |
| Windows after the fixes (run 44632322366) | ✅ core 342 passed / 12 skipped, benchmark-engine 463 / 79 skipped, web 665; ❌ database 2 timeouts at 5 s (passed in the first probe, see Decisions), runner 25, agent-adapters 19, cli 31 |
| Red first, git lookup: the new test with the old `gitFileNames` (macOS) | ❌ found the bare `git`, not `git.exe` |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (macOS) | ✅ |
| `pnpm test` (macOS, Node 24, `TMPDIR` under `/var/tmp`) | ✅ every package, 100% coverage |
| Linux and macOS CI on the branch (run 44632322366) | ✅ unit, unit-macos, oldest-node, lint, build, storybook |

| Gated Windows job with `--concurrency=1` on `9acc4db` ([run 44633696714](https://github.com/MetaX5/DirectiveBench/actions/runs/44633696714/job/135946883019)) | ✅ gated step: core 342 passed / 12 skipped, database 392 passed (no timeouts, 118 s alone), benchmark-engine 463 / 79 skipped, web 665. Reported step (`continue-on-error`): agent-adapters 19 failed, runner 25 failed, cli 31 failed, as in #301 to #303 |
| Every other CI job on `9acc4db` (run 44633696714) | ✅ unit, unit-macos, oldest-node, lint, build, storybook, e2e |
| Review gate (`om-auto-review-pr 296 --autofix`, worktree, macOS, Node 24.21): `pnpm format:check`, `lint`, `typecheck`, `test`, `build`, `verify:pack` | ✅ every command; 100% coverage in all seven packages |

**Not verified:** a real Windows machine outside CI; the product on Windows end to end (CLI,
registration and scan through the web app); ReFS or Dev Drive; whether the database tests stay
within 5 s on every Windows run (one green run with one package at a time is the evidence).

## Review

`om-auto-review-pr 296 --autofix` (engine `om-code-review`), 2026-11-20: no blocker or major
findings. One minor fixed in `fix(runner): document the Windows PATHEXT fallback`: the
`gitFileNames` doc comment still said Windows was detected by `PATHEXT` alone. Nits left as they
are: the platform stub in the git-lookup test is process-wide inside its `try`/`finally`; an empty
`PATHEXT` on Windows still finds no git (behaviour unchanged by this PR).

## Problems and deviations

- The issue's "Done when" is only partly met: three packages still fail on Windows and the job
  is not a required check. Both are explicit in the PR and the follow-ups.
- The product fix landed in a `test:` commit together with the test fixes; the PR is squashed.

## Lessons recorded

- [On Windows, an environment without PATHEXT finds no git, realpathSync keeps 8.3 names and CPU time ticks every 15.6 ms](../lessons/2026-11-19-tests-must-run-on-windows-too.md)

## Follow-ups

- #301 runner on Windows (fake `sh` git, `USERPROFILE` vs `HOME` in the D05 tests, CR LF in
  fixture remotes).
- #302 agent-adapters on Windows: real bugs suspected in the workspace import check
  (drive-letter imports) and the install move (`EPERM`, an existing `.claude` file replaced).
- #303 apps/cli on Windows.
- Make `Unit tests (Windows)` a required check once all packages are gated.
- NFR-102-04 and CR LF in users' own checkouts (decision for the maintainer, see the PR).
