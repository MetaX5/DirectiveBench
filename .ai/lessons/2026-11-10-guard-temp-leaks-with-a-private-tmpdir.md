---
title: Find test temp-directory leaks with a private TMPDIR per Vitest run, not by diffing a shared one
date: 2026-11-10
tags: [testing, vitest, tmpfs]
source: .ai/runs/2026-11-10-issue-199-test-temp-dir-guard.md
---

# Find test temp-directory leaks with a private TMPDIR per Vitest run, not by diffing a shared one

## Context

Issue #199: every `pnpm test` left 10 `directivebench-*` directories in the OS temp directory.
The runner tests called `handle.close()` in `afterEach` but never removed their `mkdtempSync`
directories. The issue suggested a guard that diffs `directivebench-*` entries in `TMPDIR` before
and after a run. `pnpm test` runs the seven packages in parallel through turbo, all in one
`TMPDIR`, so a package that finishes first would count another package's in-flight directories
as its own leaks.

Once the guard ran in every package, it found leaks the issue did not list:
`apps/cli/test/benchmark-export.test.ts` kept only the last `newScratch()` directory of a test
for removal (4 left per run), and the CLI commands leave the runner's default workspace root
`<tmp>/directivebench/workspaces`, which production keeps on purpose.

## Lesson

A Vitest `globalSetup` runs in the main process before the workers start, and the workers
inherit `process.env` changes made there. Pointing `TMPDIR`, `TMP` and `TEMP` at a fresh
private directory gives every package run its own temp root: `os.tmpdir()` follows it in every
test. The teardown then only has to check that this directory is empty. That works with parallel
runs and catches leaks under any name, not just `directivebench-*`.

## How to apply

- The guard is `vitest.tmp-guard.ts`, exported as `tempDirGuard` from `vitest.shared.ts`. Every
  `vitest.config.ts` lists it in `globalSetup`. A new package config must list it too.
- A leak fails the run with `Tests left N entries in the temp directory: …`. Remove what the
  test creates in `afterEach`/`afterAll` or `try/finally`, and keep every directory a test
  creates, not just the last one assigned to a shared variable.
- The guard allows only the empty `directivebench/workspaces` root. Anything inside it is a
  leak. Do not add more exemptions to pass the gate; fix the test.
- `node-compile-cache` in the real `TMPDIR` comes from Node's module compile cache in the Vitest
  main process, before `globalSetup` runs. It is not a test leak.
