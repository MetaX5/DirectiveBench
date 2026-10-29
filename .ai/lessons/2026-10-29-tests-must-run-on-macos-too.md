---
title: Tests must run on macOS too; never kill a pid parsed from output without checking it
date: 2026-10-29
tags: [testing, ci, macos, processes]
source: .ai/runs/2026-10-29-macos-ci-gate.md
---

# Tests must run on macOS too; never kill a pid parsed from output without checking it

## Context

Issue #120 added a `macos-latest` unit job. The first run (PR #159) failed in four packages, and
the cause was in the tests every time, not in the product:

- `setsid` is a util-linux command; macOS does not ship it. The escape test's script never
  wrote its pid file, so stdout was empty, and `process.kill(Number(''), 'SIGKILL')` is
  `kill(0)`. That SIGKILLed the test runner's own process group: vitest and turbo exited with
  137, and the job lost the rest of its output.
- A kill-escalation test set a 100 ms timeout. On a slow start, SIGTERM arrived before the
  fake's `sh` reached `trap '' INT TERM`, which was already its first command. The fake then
  died of SIGTERM, or never wrote its pid and the test waited 10 s. A 0.3 s `sleep` before
  `trap` reproduces this on Linux.
- APFS rejects a file name that is not valid UTF-8 (`EILSEQ`), so the fixture could not be
  created on disk.
- A wall-clock ratio of two samples, one under a millisecond, measured 48 against a bound of 40.

## Lesson

- A process that must leave its group: `perl -MPOSIX -e 'setsid() >= 0 or die; exec @ARGV' …`
  works on Linux and macOS.
- Before `process.kill(pid)` on a pid read from a file or from output, assert `pid > 0`: 0 and
  negative values signal whole process groups, the runner's own included.
- Trigger a test's timeout or cancellation after the child signals it is ready (it writes its
  pid after installing its handlers). A fixed short timer races the child's start.
- Byte-exact git paths belong in the index (`git update-index --index-info` with the raw bytes
  on stdin), not on the file system.
- Every linear-time test uses `expectLinearTime` (lesson 2026-10-21); a hand-made ratio does not
  survive a different machine.

## How to apply

Write shell fixtures in POSIX `sh`, without GNU or util-linux tools. Use the readiness pattern
for every signal test. To check macOS without a Mac, push and read the `Unit tests (100%
coverage, macOS)` job.
