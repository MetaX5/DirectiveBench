---
title: Prove that a hosted step did not run with a logging git on PATH, and race it through the transport
date: 2026-11-16
tags: [testing, git, runner]
source: .ai/runs/2026-11-16-issue-63-skip-unchanged-hosted-rescan.md
---

# Prove that a hosted step did not run with a logging git on PATH, and race it through the transport

## Context

Issue 63 had to show that a rescan of an unchanged remote runs no fetch. The scan result alone
cannot show it (a fetch of an up-to-date cache changes nothing either), and the fake git of
`test/support/hosted-fixtures.ts` answers from a script, so it cannot prove that real git with a
real bare remote skipped the step. The fast path also had to handle a cancellation, a removal and
a sync failure that land between the `ls-remote` and the database write.

## Lesson

- A shell wrapper named `git` that appends `"$*"` to a log and `exec`s the real git (absolute
  path from `command -v git`), first on the `PATH` passed in `HostedRepositoryOptions.env`, records
  every subcommand a real-git scan runs. `findGitExecutable` picks it like any git on `PATH`, and
  the hosted environment allowlist keeps `PATH` absolute, so the log path must be written into the
  script, not passed as a variable. Old code ran `version, fetch, clone`; the fast path runs
  exactly `version, ls-remote`.
- `HostedGitTransport.remoteUrl` is called synchronously right before git is given the URL, so a
  test transport that runs a one-shot hook there (`update jobs set cancel_requested_at …`,
  `delete from repositories …`) injects a concurrent change between a remote step and the write
  without timers or mocks.

## How to apply

For a hosted change that claims a git step does or does not run, assert the logged subcommands
with real git over `file://` (POSIX only: `posixOnly`), and use an armed `remoteUrl` hook for
anything that must land during a remote step.
