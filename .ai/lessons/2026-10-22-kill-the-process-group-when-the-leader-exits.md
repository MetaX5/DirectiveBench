---
title: A command's exit is not the end of what it started — kill its process group on exit and wait
date: 2026-10-22
tags: [processes, security, testing]
source: .ai/runs/2026-10-22-issue-101-process-control.md
---

# A command's exit is not the end of what it started — kill its process group on exit and wait

## Context

`runCommand` signalled a `setup` command's process group only on timeout or cancellation. A
`setup` that backgrounded a child with its output redirected (`sleep 1; write .claude/… &`)
exited 0 and the child kept running past installation and the pre-spawn inspection (PR #108
Codex review). A background child that *inherited* stdout did the opposite: Node's `close` waits
for every holder of the pipe, so the command looked hung until its timeout. Issue #101 fixed both.

## Lesson

- Kill the group on the leader's `exit` event (not `close`): that ends survivors and closes the
  pipes they hold, so `close` follows at once.
- `kill(-pgid, SIGKILL)` returning is not "gone": a killed member stays visible to
  `kill(-pgid, 0)` until its new parent reaps it. Poll until `ESRCH` with a named bound
  (`PROCESS_GROUP_EXIT_TIMEOUT_MS`) and fail closed (`strayProcesses`) when it does not happen —
  e.g. a container whose PID 1 never reaps orphans, or a set-uid member (`EPERM`).
- A process that calls `setsid` leaves the group and can hold the output pipes forever; bound the
  wait for `close` after `exit` (`CLAUDE_OUTPUT_DRAIN_MS`) and destroy the streams.
- A failed `spawn` (ENOENT) still emits `close`, with the negative errno as the "exit code";
  report `exitCode: null` when there was no pid.

## How to apply

- Every runner of untrusted commands uses `killProcessGroup` from `@directivebench/agent-adapters`
  on exit; prove it with a regression test whose background child closed its output, and check
  the child's pid is `ESRCH` when the call returns (revert the fix once to see the test fail).
- Fake CLIs that must ignore signals install `trap '' INT TERM` as their first line and write a
  pid file afterwards; tests wait for that file before signalling.
