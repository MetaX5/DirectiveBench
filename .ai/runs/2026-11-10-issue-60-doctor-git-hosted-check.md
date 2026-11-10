---
title: doctor reports git and GIT_SSL_CAINFO for hosted repositories (issue #60)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue chain)
trigger: issue #60 and its comment (from PR #73, issue #61)
status: in-progress
branch: feat/issue-60-doctor-git-hosted-check
specs: [SPEC-009, SPEC-104, SPEC-105]
---

# Run: doctor reports git and GIT_SSL_CAINFO for hosted repositories

## Objective

Issue #60: `directivebench doctor` prints the git path and version and a clear yes/no for hosted
repositories (git 2.44 or newer, NFR-104-03). The issue comment adds a `GIT_SSL_CAINFO` check:
set or not, and whether it resolves to a readable regular file (the check of `resolveCaBundle` in
`packages/runner/src/hosted-git.ts`), without printing the file's contents. Tests use a fake git,
no network.

## Plan

om-verify-in-repo → om-root-cause → om-fix → om-open-pr --handoff → om-auto-review-pr --autofix
(review submitted as COMMENT). The issue is labelled `enhancement` but is covered by SPEC-009 §4
(doctor checks) and SPEC-104 NFR-104-03, so it takes the bug-chain shape on a `feat/` branch
without a new spec, as for issue #74. Scope: `apps/cli` only. No edit of
`packages/runner/src/hosted-git.ts` (open PR #200 touches it).

## Decisions

- Reuse, not copy: doctor calls the runner's exported `findGitExecutable`, `buildGitEnv`,
  `MIN_HOSTED_GIT_VERSION`, `CA_BUNDLE_VARIABLE` and `resolveCaBundle`, and `readVersionLine` of
  `@directivebench/agent-adapters` (named 5 s timeout, output cap). No new export was needed. The
  only copied piece is the `^git version (\d+)\.(\d+)` comparison of `checkGitVersion`, which
  needs a `HostedGitContext` and cannot run outside a hosted job.
- Both checks `warn`, never `fail`: hosted repositories are optional, so a missing or old git does
  not make `doctor` exit 6. The detail says `hosted repositories: yes` or `no`.
- The CA bundle check names only the variable. On success it does not print the resolved path
  either, matching the runner, which redacts it as `<CA bundle>`.
- Check names `git` and `git:ca-bundle`, in the `name:sub` style of the agent checks.
- The config `baseBranch` is `auto`; it resolves to the default branch `main`.

## Work performed

1. Triage: issue open and unclaimed, no PR or `origin/main` commit references #60; `doctorCommand`
   had no git check.
2. `apps/cli/src/commands.ts`: `gitCheck` and `caBundleCheck`, run after the port check.
3. `apps/cli/test/doctor.test.ts`: a fake `git` on the test PATH (2.44.0 in the healthy run),
   accepted versions (2.44.0, Apple 2.53.0, Windows 2.45.1, 3.0.0), refused versions (2.43.7,
   1.99.0), a failing and an unparseable `git version`, git missing, and `GIT_SSL_CAINFO` unset,
   a readable file (path and contents not printed), a relative path, a directory and a missing
   file (path not printed).
4. SPEC-009 §4 and §12 implementation status; README doctor line.

## Verification

| Check | Result |
| --- | --- |
| Red: new `doctor.test.ts` against the `origin/main` `commands.ts` | 13 fail (no `git` / `git:ca-bundle` check: `expected undefined to deeply equal { name: 'git', … }`) |
| Green: `vitest run test/doctor.test.ts` | 26 passed |
| Seam check: version rule `>= minor - 1` | 1 fails (`warns about git version 2.43.7`) |
| Seam check: `major >` branch removed | 1 fails (`accepts git version 3.0.0`) |
| Seam check: `resolveCaBundle` replaced by "always ok" | 3 fail (relative path, directory, missing file) |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test --concurrency=1 --continue` | 6 of 7 packages pass at 100%; apps/cli 175/176 at 100% coverage, the failing test is pre-existing and environment-dependent (see Problems) |
| `pnpm build`, `pnpm verify:pack` | pass ("Packaging verification passed") |
| Manual: built `node apps/cli/dist/cli.js doctor` | git 2.48.1 ok with `hosted repositories: yes`; a fake git 2.43.0 first on PATH warns with the hint, exit 0; `GIT_SSL_CAINFO` unset, a readable file, `relative.pem` and a directory give the expected lines, no path or contents printed |

Not verified:

- A real git older than 2.44 (a fake script stood in for it) and Windows (`git.exe`, `PATHEXT`).
- The `missing file` CA case on the built CLI (covered by the unit test only).

## Problems and deviations

- `cli.test.ts` "warns with a hint when the data directory does not exist yet" fails on this
  machine, with and without this change (checked on `origin/main` code): `claude` is installed
  here but not logged in under Vitest, and the `agent:claude-code:subscription` and
  `agent:claude-code:api-key` checks warn without a `hint`, which SPEC-009 §3 requires for every
  non-`ok` check. CI has no `claude`, so it does not see this. Not changed here (out of scope).
- The machine was under heavy load from parallel agents (load average 28): the first `pnpm test`
  had several unrelated timeouts; the rerun with `--concurrency=1` had none.

## Lessons recorded

None. No non-obvious bug or new constraint.

## Follow-ups

- The agent readiness checks of `doctor` warn without a `hint` (SPEC-009 §3), which makes the
  `cli.test.ts` hint test depend on whether `claude` is installed and logged in.
