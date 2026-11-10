---
title: A doctor test pins PATH, or it tests the machine it runs on
date: 2026-11-10
tags: [testing, cli, doctor]
source: .ai/runs/2026-11-10-issue-60-doctor-git-hosted-check.md
---

# A doctor test pins PATH, or it tests the machine it runs on

## Context

`apps/cli/test/cli.test.ts` "warns with a hint when the data directory does not exist yet" ran
`doctor` with the real `PATH`. It asserts that every non-`ok` check carries a `hint`. On a machine
with `claude` installed but not logged in under Vitest, the `agent:claude-code:subscription` and
`agent:claude-code:api-key` checks warn without a hint, so the test failed locally, on
`origin/main` code as well. CI has no `claude`, so CI never saw it. Issue #60 adds a `git` check,
which also depends on the git found on `PATH`.

## Lesson

`doctor` reads the machine: agent CLIs, their login state, and git on `PATH`, plus
`GIT_SSL_CAINFO`. A test that runs it without pinning these passes or fails depending on what
the developer or CI runner has installed.

## How to apply

- Stub `PATH` in every `doctor` test (`vi.stubEnv('PATH', <temp dir>)`), with fake `claude` or
  `git` scripts in that directory when a test needs them (`doctor.test.ts` does this).
- Stub `GIT_SSL_CAINFO` (to `undefined` or a planted file) in tests that assert the
  `git:ca-bundle` check.
- `vi.unstubAllEnvs()` in `afterEach`.
