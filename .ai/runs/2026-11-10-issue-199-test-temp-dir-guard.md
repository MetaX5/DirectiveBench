---
title: Stop tests leaving directories in the OS temp dir, and guard every package against it (issue #199)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue chain)
trigger: issue #199, run through om-auto-fix-issue 199
status: completed
branch: fix/issue-199-runner-tests-leave-tmp-dirs
specs: [SPEC-012]
---

# Run: Stop tests leaving directories in the OS temp dir, and guard every package against it

## Objective

Issue #199: every `pnpm test` left 10 `directivebench-*` directories in the OS temp directory,
against AGENTS.md §3 and SPEC-012 §1 principle 4. Done when `pnpm test --force` with an empty
dedicated `TMPDIR` leaves it empty, a guard wired into every package's Vitest config fails the
run on a leftover, the guard has a test that proves it catches a leak, and coverage stays at
100%.

## Plan

om-verify-in-repo → om-root-cause → om-fix → om-open-pr --handoff → om-auto-review-pr --autofix
(review submitted as COMMENT). Scope: test files, Vitest configs and the new guard. No
production code. Not touched: `packages/runner/src/hosted-git.ts` (PR #200), the
`packages/database` tests (#177), `apps/cli` doctor (#60) and the `apps/web` Versions tab (#65).
Only the one-line `globalSetup` entry touches the configs of those packages.

## Decisions

- **A private temp directory per run, not a before/after diff.** `test-support/temp-dir-guard.ts` is a
  Vitest `globalSetup`. It points `TMPDIR`, `TMP` and `TEMP` at a fresh
  `directivebench-vitest-*` directory, and its teardown fails the run when anything is left in
  it, then removes it either way. turbo runs the seven packages in parallel in one `TMPDIR`, so
  the issue's diff of `directivebench-*` entries would count another package's in-flight
  directories as leaks. The private directory isolates the runs and also catches leaks with
  other prefixes (it found `db-cli-export-out-*`). Recorded in a lesson.
- **One allowed entry: the runner's empty default workspace root.** The CLI commands never pass
  `workspaceRoot`, so `LocalRunner` uses `<tmp>/directivebench/workspaces`, which production
  keeps on purpose (moving it is a non-goal of the issue). The guard accepts that directory only
  when it is empty; any run workspace inside it, and any other entry under `directivebench`, is
  reported.
- **The guard lives in `test-support/`**, the home of shared test code (like `linear-time.ts`),
  which turbo lists in the `test` and `typecheck` cache inputs. `vitest.shared.ts` exports its
  path as `tempDirGuard`. Its tests are in `packages/core/test/temp-dir-guard.test.ts`, the
  package at the root of the dependency graph, as for `linear-time.ts`. `test-support/` is
  outside every coverage `include`; the guard's coverage was measured separately (100%). It was
  first at the repository root; review round 1 moved it (see below).

## Work performed

1. Triage: issue open and unclaimed. No open or closed PR and no commit on `origin/main`
   references #199.
2. Red: `TMPDIR=<empty dir> vitest run` in `packages/runner` on `origin/main` (8b137bb): 244
   tests pass and 10 entries remain (6 `directivebench-runner-*`, 2 `directivebench-runner-docs-*`,
   2 `directivebench-doc-suite-*`), plus Node's `node-compile-cache`.
3. Guard added and wired into `packages/runner` first. Against the unfixed tests it failed the
   run: `Tests left 10 entries in the temp directory: directivebench-doc-suite-…, …`.
4. Runner tests fixed: `runner.test.ts` and `document-assertions.test.ts` remove the data
   directory in `afterEach` after `handle.close()`; `writeSuite()` roots are tracked and
   removed in `afterEach`.
5. Guard wired into all seven `vitest.config.ts`. The first full run found 4
   `db-cli-export-out-*` and `directivebench` in `apps/cli`. `benchmark-export.test.ts` stored
   only the last `newScratch()` directory of a test in one variable; it now tracks every scratch
   directory in a list. `directivebench` was the runner's default workspace root (decision
   above).
6. Guard tests: six cases, including leaks at the top level, inside `directivebench/workspaces`,
   a file named `directivebench` and the real `globalSetup` entry.
7. SPEC-012 §9 implementation-status note and a new lesson. Commit f057693; PR #203 opened
   (labels `review`, `bug`, `needs-qa`, `priority-low`, `risk-low`).
8. Review round 1 (`om-auto-review-pr 203 --autofix`, engine `om-code-review`, submitted as
   COMMENT): request changes, 0 blockers, 1 major, 1 nit. Major: the guard sat at the root,
   outside turbo's `test`/`typecheck` inputs (`test-support/**`, `vitest.shared.ts`), so a
   guard-only edit could be served from the cache. Merged `origin/main` (#200, no conflict),
   moved the guard to `test-support/temp-dir-guard.ts` (ab5d435). Nit: this run log was still
   `in-progress`; finalised here.
9. Review round 2 (re-review, COMMENT): approve verdict, no findings.

## Verification

- Red, as above: 10 leftovers in the runner run on `origin/main`; the guard fails the run on
  them.
- Green: `TMPDIR=<empty dir> pnpm test --force --continue --concurrency=2`. The guard reports
  nothing in any package. Afterwards the dedicated `TMPDIR` holds only `node-compile-cache`.
  Coverage is 100% in every package. After the merge of `origin/main`: core 297 passed + 2
  skipped, database 215, agent-adapters 364 + 2 skipped, benchmark-engine 518, runner 250, web
  503, cli 163 of 164 (see below).
- Seam checks: guard throw disabled → 3 of 6 guard tests fail. Directory check made
  unconditional (`||` for `&&`) → 3 of 6 fail. Without the runner test fix → the guard fails
  with 10 entries. Without the export test fix and without the workspace-root allowance → the
  guard fails in `apps/cli` with `db-cli-export-out-*` (4) and `directivebench`.
- Guard coverage, measured with `--coverage.include=../../test-support/temp-dir-guard.ts
  --coverage.allowExternal`: 100% statements, branches, functions and lines.
- `pnpm format:check` pass, `pnpm lint` pass, `pnpm typecheck` pass (7/7), `pnpm build` pass,
  `pnpm verify:pack` pass ("Packaging verification passed").
- Not verified: Windows (the guard sets `TMP`/`TEMP` for `os.tmpdir()` there, but no Windows
  run). Child processes whose environment allowlist drops `TMPDIR` would still write to the
  system temp directory. The guard does not see that.

## Problems and deviations

- `apps/cli` `test/cli.test.ts > doctor > warns with a hint when the data directory does not
  exist yet` fails on this machine. It also fails with the unchanged `origin/main` Vitest config
  and the real `TMPDIR`, so it predates this change. The built CLI's `doctor --json` shows the
  cause: with a local, logged-out `claude` install, `agent:claude-code:subscription` and
  `agent:claude-code:api-key` are `warn` without a `hint`, so `every non-ok check has a hint` is
  false. CI has no `claude` installed. Out of scope here (`apps/cli` doctor) and left alone. The first full run also had 5 s timeouts in several packages at load average 31
  (other agents running); with `--concurrency=2` they passed.
- turbo needs `pnpm` on `PATH`; corepack shims were installed into
  `.ai/tmp/om-auto-fix-issue/bin` for the run and removed afterwards.

## Lessons recorded

- [Find test temp-directory leaks with a private TMPDIR per Vitest run](../lessons/2026-11-10-guard-temp-leaks-with-a-private-tmpdir.md) (new).

## Follow-ups

- Doctor: the Claude Code readiness warnings (`auth-missing`) have no `hint`, which makes
  `cli.test.ts > doctor > warns with a hint …` fail on any machine with a logged-out `claude`.
  Worth an issue for the doctor work.

- `node-compile-cache` stays in the real `TMPDIR` after a run. It is Node's module compile cache,
  created by the Vitest main process before `globalSetup`, and is reused across runs.
