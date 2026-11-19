---
title: CI job on the oldest supported Node (22.16) for SQLite-dependent tests (issue 263)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue)
trigger: issue #263
status: completed
branch: chore/issue-263-ci-oldest-node
specs: [SPEC-012, SPEC-014, SPEC-004]
---

# Run: CI job on the oldest supported Node (22.16)

## Objective

Issue #263: `engines.node` is `>=22.16.0` but every CI job ran Node 24, so SQL that only Node 24's
bundled SQLite accepts (migration `0009` in PR #259) passed CI. Add a required CI job on exactly
Node 22.16.0 that runs at least the database tests including migrations and prints the SQLite
version; reuse `.github/actions/setup`; document the rule in AGENTS.md, SPEC-014 and the lesson.
Red-first: the job fails on the pre-fix `0009` SQL and passes after reverting it.

## Plan

1. `node-version` input on `.github/actions/setup` (default 24).
2. Job `oldest-node` in `ci.yml`; check locally with an official Node 22.16.0 binary in `/var/tmp`.
3. Docs: AGENTS.md §2 rule 13, SPEC-014 §9/§10, SPEC-012 §8, SPEC-004 §3.1, lesson.
4. Red-first CI proof: a temporary commit restoring `0009` from `cc295ce^`, then its revert.

## Decisions

- **What runs on 22.16.0:** the tests of every `packages/*` package (core, agent-adapters,
  database incl. all migrations from empty and earlier states, benchmark-engine, runner), then
  `pnpm build` and `pnpm verify:pack`. Broader than the issue's minimum because all five pass and
  cost about one minute; `verify:pack` runs the packed CLI and web app (demo, export, serve) on
  22.16.
- **No coverage threshold** (`--coverage.enabled=false`): the 100% gate is about which code the
  tests reach and stays on the Node 24 `unit` and `unit-macos` jobs; this job checks that the code
  runs on the oldest runtime.
- **apps/cli and apps/web unit tests excluded for now**, because they fail on 22.16 for reasons
  outside this issue, filed as #265 (node:sqlite on Node 22 truncates TEXT at the first NUL on
  read: one CLI export test) and #266 (two web worker tests start the `.ts` worker entry, which
  needs native type stripping from Node 22.18).
- **Drift guard:** the job fails when `engines.node` in the root or `apps/cli` `package.json` is
  not `>=` the Node it runs, so the job cannot silently stop testing the minimum.
- **Single source for the version:** job-level `env.OLDEST_NODE`.
- Route: the issue is labelled `feature`, but it is CI-only with no product behaviour; the caller
  asked for a `chore/` branch and a draft PR, and the covering specs (SPEC-012 §8, SPEC-014) were
  updated in place instead of writing a new spec.

## Work performed

1. `dea3d46` ci: setup action `node-version` input, job `oldest-node`, AGENTS.md, SPEC-012, SPEC-014,
   lesson.
2. `034a91e` temporary red-first commit restoring `0009` from `cc295ce^`; `435f42d` reverts it.
3. Review round (om-auto-review-pr): SPEC-004 §3.1 and its status still called Node 22 untested and
   CI on Node 22 not implemented; SPEC-012 §8 still said "all four" jobs are required. Fixed with
   the CI evidence.
4. Follow-up issues #265 (NUL truncation on Node 22) and #266 (web worker tests need type
   stripping).

## Verification

| Check | Result |
| --- | --- |
| Local Node 22.16.0 (official tarball in `/var/tmp`, SHA-256 checked), SQLite 3.49.1 | `packages/*` tests without coverage: 1,932 passed; `pnpm build` and `pnpm verify:pack`: pass |
| Local red: `0009` from `cc295ce^` on Node 22.16.0 | database: 367 of 377 failed, `no such column: artifacts.type` |
| Local full `pnpm -r test` without coverage on 22.16.0 | `apps/cli` 1 failure (#265), `apps/web` 2 failures (#266), the rest pass |
| CI red ([run 44127046218](https://github.com/MetaX5/DirectiveBench/actions/runs/44127046218/job/134193574720), head `034a91e`) | `oldest-node` failed: database 367 failed, `no such column: artifacts.type` |
| CI green ([run 44127456059](https://github.com/MetaX5/DirectiveBench/actions/runs/44127456059/job/134195228801), head `435f42d`) | `oldest-node` passed: `Node v22.16.0, node:sqlite SQLite 3.49.1`, 1,932 tests, build, verify:pack |
| `pnpm format:check`, `lint`, `typecheck`, `test`, `build`, `verify:pack` (Node 24.21) | all pass (`test` was a Turborepo cache hit: no test input changed) |
| Codex adversarial review, round 1 | approve, no findings |

Not verified: the drift guard's failure branch in CI (checked locally only: Node 24 yields
`>=24.21.0`, which differs from `engines.node`); branch protection (a repository setting).

## Problems and deviations

- In run 44127456059 the Node 24 `unit` job timed out once in
  `runner-lifecycle.test.ts` "two runners sharing one database" (5 s); no code changed in this PR,
  and the same test passed in `oldest-node`. Recorded as a flake.
- The issue is labelled `feature`; it was handled as a CI change on a `chore/` branch with the
  covering specs updated in place (see Decisions).

## Lessons recorded

- Updated `.ai/lessons/2026-11-17-run-migration-sql-on-the-oldest-supported-sqlite.md` (links the
  job; Node 22's `node:sqlite` truncates TEXT at a NUL on read; local Node 22.16 recipe).

## Follow-ups

- #265, #266, then add `apps/cli` and `apps/web` tests to `oldest-node`.
- Maintainer: make `Oldest supported Node (22.16.0)` a required check in branch protection.
