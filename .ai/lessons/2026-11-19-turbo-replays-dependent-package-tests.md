---
title: pnpm test replays cached results of packages that depend on the one you changed
date: 2026-11-19
tags: [testing, turbo, tooling]
source: .ai/runs/2026-11-19-issue-275-runtime-reserved-name-check.md
---

# pnpm test replays cached results of packages that depend on the one you changed

## Context

Issue 275 changed `packages/agent-adapters` and `packages/benchmark-engine`. `pnpm test`
(`turbo run test`) passed, but its log showed `directivebench:test: cache hit, replaying logs`
(and the same for `runner`, `core`, `database`, `web`). Running the CLI tests directly showed 9
failures: the CLI's fake `claude` replayed a session start that a `none` baseline can no longer
have. The `test` task in `turbo.json` has no `dependsOn`, so a change in a workspace dependency
does not change a dependent's task hash in the shared worktree cache.

## Lesson

A green `pnpm test` after a change to a package does not prove that the packages depending on it
still pass: their results can be replayed from the cache of an older run. CI starts without that
cache, so it would fail there instead.

## How to apply

- After changing anything under `packages/*`, run `pnpm exec turbo run test --force` (or the
  dependents' tests directly) before claiming the gate passed, and check the log for
  `cache hit` lines of dependent packages.
- Making `test` depend on its dependencies' sources in `turbo.json` would fix it at the root; that
  is a tooling change of its own, not part of a feature PR.
