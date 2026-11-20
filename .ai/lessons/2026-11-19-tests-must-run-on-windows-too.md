---
title: On Windows, an environment without PATHEXT finds no git, realpathSync keeps 8.3 names and CPU time ticks every 15.6 ms
date: 2026-11-19
tags: [testing, ci, windows]
source: .ai/runs/2026-11-19-issue-160-windows-test-gate.md
---

# On Windows, an environment without PATHEXT finds no git, realpathSync keeps 8.3 names and CPU time ticks every 15.6 ms

## Context

Issue 160 added a `windows-latest` unit job. The first probe (run 44630522356) failed 203 tests
in six packages. The causes that hid behind the most failures:

- **"git was not found on PATH." (48 runner failures).** `findGitExecutable` took the file
  names from `env.PATHEXT` and looked for a bare `git` when it was missing. The runner passes
  `process.env`, which has `PATHEXT`, but many tests passed `{ PATH }` alone, and on Windows no
  file is called `git`. The lookup now falls back to `.COM;.EXE` on `win32`.
- **8.3 short names.** The Windows runner's temp directory is `C:\Users\RUNNER~1\…`.
  `fs.promises.realpath` and `realpathSync.native` expand it to `runneradmin`;
  `realpathSync` (the JavaScript implementation) keeps `RUNNER~1`. Tests that computed an
  expected path with `realpathSync` disagreed with the product's `realpath`.
- **The CPU clock.** `process.threadCpuUsage` and `process.cpuUsage` advance in scheduler ticks
  of about 15.6 ms on Windows. A 20 ms linear-time sample read as one or two ticks, and the N^1.5
  control measured 2.9 instead of about 5.7.
- **Checkouts with CR LF.** `core.autocrlf` is on in the Windows runner's git, so the bundled
  example hashed differently (comparability key `6645fc…` instead of `8212a3…`).
- **POSIX path literals.** `path.endsWith('references/api.md')` in test hooks, `'/tmp/a'` as an
  expected `resolve()` result and allowlists keyed by `relative()` paths never match `\`.
- **Expected platform behaviour that the tests had guessed:** libuv adds `SYSTEMROOT`,
  `USERPROFILE` and others to a child's explicit environment; Node reports `SIGTERM` for a child
  it killed on Windows too; `chmod 000` does not stop Windows from listing a directory; Windows
  has no FIFOs in the file system; without `O_NOFOLLOW` an open follows a link and only the
  identity check refuses it.

## Lesson

- Platform-dependent lookups key on `process.platform`, not on whether a variable happens to be
  set, and fall back to the platform default.
- Compare paths with what the product computes: `realpathSync.native` in tests, never the
  JavaScript `realpathSync`, when the product uses `fs.promises.realpath`.
- A CPU-time measurement lasts many ticks of the clock it reads (`minSampleMsOf` in
  `test-support/linear-time.ts`).
- `.gitattributes` keeps every checkout LF (`* text=auto eol=lf`).
- Turn paths into `/` form before matching them (`split(sep).join('/')`) and build expected
  paths with `join`/`resolve`.
- A test that relies on POSIX permissions, FIFOs or signals runs with
  `it.skipIf(process.platform === 'win32')` and a comment that says why.

## How to apply

Before adding a test that touches paths, processes, permissions or timing, check it against the
list above. The `Unit tests (Windows)` job runs the gated packages on every PR; a new failure
there is a Windows bug or a non-portable test, not noise.
