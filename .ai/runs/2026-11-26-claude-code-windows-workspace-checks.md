---
title: Claude Code workspace checks on Windows (issue 302)
date: 2026-11-26
agent: Claude Code / claude-opus-5-5
trigger: user request ("bierzemy #302"), om-auto-fix-issue 302
status: completed
branch: fix/issue-302-windows-workspace-checks
specs: [SPEC-118, SPEC-203, SPEC-012]
---

# Run: Claude Code workspace checks on Windows (issue 302)

## Objective

Issue #302: `packages/agent-adapters` failed 19 tests on `windows-latest` (run 44632322366), and
some failures were real gaps in fail-closed checks. Done when (from the issue):

- a Windows absolute import (drive letter and UNC) in a workspace file is refused like a POSIX
  one, with a regression test that runs on every platform;
- an install onto an occupied `.claude` (directory, file or link) fails closed with
  `artifact-install-conflict` on Windows;
- `@directivebench/agent-adapters` moves into the gated step of `Unit tests (Windows)` and it is
  green; POSIX-only skips have reasons.

## Plan

`om-auto-fix-issue` bug chain: verify (real, unfixed) → root cause → fix with regression tests →
PR → review → CI on Windows.

## Decisions

- **Windows absolute tokens are classified on every platform** (`isAbsolute` in
  `import-tokens.ts`): `X:\`, `X:/`, a leading `\` (UNC or drive-rooted). On Linux/macOS such a
  token resolves against the process directory and is almost always missing, so it adds no
  findings there; the classifier test runs everywhere (the issue's open question).
- **A lone backslash counts as a path separator** for `.`/`..` segments and repeated separators
  (`seenDotDot`, `seenShortening`). Without it a relative `a\..\..\x` was never checked on Windows,
  and a too-long `C:\…\..\x` token would only have its cut prefixes checked instead of failing
  closed. Found while implementing; not in the issue text.
- **Cut variants of an absolute token that are no longer absolute (`C:`, `C`) are dropped**, like
  the existing `~` rule: they name a drive's current directory or a name in the process directory,
  never a file the import could disclose.
- **`moveIntoPlace` checks `.claude` with `lstat` before `rename`**, only for `.claude`:
  `CLAUDE.md`/`AGENTS.md` intentionally replace the file read before (append semantics). After
  the move the existing check still refuses a replaced entry; `EPERM` maps to the conflict only
  when the destination exists, so a genuine permission error still propagates.

## Work performed

1. `src/claude-code/import-tokens.ts`: `isAbsolute`, backslash as separator, variant filter.
2. `src/claude-code/install.ts`: pre-move `.claude` check, `EPERM` mapping.
3. Regression tests: `import-tokens.test.ts` (Windows absolute tokens, backslash `..`, too-long),
   `races.test.ts` (Windows replacing `rename` simulated by a hook, `EPERM` with and without a
   destination).
4. Portable tests: `paths.test.ts`, `env.test.ts`, `races.test.ts` (entry-limit hook path),
   `install.test.ts` and `workspace-inspection.test.ts` (chmod and FIFO cases skipped on win32
   with a reason; the hard-link case split from the FIFO case so it still runs on Windows).
5. `.github/workflows/ci.yml`: `agent-adapters` moved into the gated Windows step; SPEC-012 §8
   text updated.

## Review

- Self-review (`om-code-review`, round 1) found one more Windows gap: the symbolic-link climb guard in
  `workspace-inspection.ts` used `posix.normalize`, so on Windows `a\..\..\x` in a workspace with links
  was not refused. Now the platform `normalize` (identical on Linux/macOS); a Windows-only test
  (`it.runIf(win32)`) covers it in the Windows CI job.

## Verification

- Red first (Linux): the 2 new `import-tokens` tests fail against the old `import-tokens.ts`; the
  2 new `races` tests fail against the old `install.ts`. Both pass with the fix.
- `pnpm --filter @directivebench/agent-adapters test`: 405 passed, 2 skipped, 100% coverage.
- Full gate (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify:pack`, Linux, Node 24): exit 0; core 354, agent-adapters 405 (+2 skipped), database 392, benchmark-engine 542, runner 322, cli 216, web 686 tests, 100% coverage; packaging verification passed.
- Windows: `Unit tests (Windows)` on PR #306 passed with `agent-adapters` in the gated step: 285 passed, 123 skipped ([run 45837275637](https://github.com/MetaX5/DirectiveBench/actions/runs/45837275637/job/139969566626)). Every other check on the PR passed too (Linux and macOS 100% coverage, oldest Node, e2e, Storybook, build and pack, CodeQL).
- Not verified: a real Windows machine and the real `claude` CLI on Windows (non-goal). The skipped Windows cases are not counted one by one, and the run of the Windows-only climb test is inferred from `it.runIf(win32)`, not from a per-test log line.

## Problems and deviations

- First version of the pre-move check refused every existing destination; that would have broken
  `claude-md`/`agents-md` installs into a workspace with a `CLAUDE.md`. Restricted to `.claude`
  before running tests.

## Lessons recorded

- [A safety check built on POSIX path shapes or POSIX `rename` fails open on Windows](../lessons/2026-11-26-windows-paths-break-posix-shaped-safety-checks.md)

## Follow-ups

- #301 (`runner`) and #303 (`apps/cli`) remain in the non-gated Windows step.
- The TOCTOU window between the `.claude` `lstat` and `rename` remains by design; it is covered by
  `rename` failing on a populated directory and by the post-move check.
