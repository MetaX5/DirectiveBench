---
title: pnpm test replays cached results of packages that depend on the one you changed
date: 2026-11-19
tags: [testing, turbo, tooling]
updated: 2026-11-19
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

- **Fixed on 2026-11-19 (issue #281):** `turbo.json` has a `transit` task with
  `"dependsOn": ["^transit"]`, and `test` has `"dependsOn": ["transit"]`. No package has a
  `transit` script, so turbo runs nothing for it, but its hash covers the package's files and,
  through `^transit`, every workspace dependency's files. A change in `packages/agent-adapters/src`
  now re-runs the tests of `benchmark-engine`, `runner`, `web` and `directivebench`, while `core`
  and `database` still hit the cache. This is Turborepo's documented "transit node" pattern; it
  adds no ordering between packages' tests, unlike `^test` or `^typecheck`.
- `typecheck` never had the gap: its `"dependsOn": ["^typecheck"]` already puts the dependencies'
  hashes into its own.
- Do not add a `transit` script to a package: turbo would then run it before every `test`.
- When you add a new turbo task whose result depends on other workspace packages' sources, give it
  a `^` dependency (`^transit` when it must not wait for real work), and check it with
  `pnpm exec turbo run <task> --dry=json` after a one-line change in a dependency: every
  dependent must show `MISS`.
