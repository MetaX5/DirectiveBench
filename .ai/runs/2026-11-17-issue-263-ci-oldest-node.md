---
title: CI job on the oldest supported Node (22.16) for SQLite-dependent tests (issue 263)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue)
trigger: issue #263
status: in-progress
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

(filled in at the end)

## Verification

(filled in at the end)

## Problems and deviations

## Lessons recorded

## Follow-ups
