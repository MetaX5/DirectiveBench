---
title: A process-group SIGKILL can miss a child forked during the kill; kill the group again once the leader exits
date: 2026-11-19
tags: [testing, ci, flaky, processes, macos]
source: .ai/runs/2026-11-19-issue-297-flaky-runner-timing-tests.md
---

# A process-group SIGKILL can miss a child forked during the kill; kill the group again once the leader exits

## Context

`git-process.test.ts` "kills git on timeout, with SIGKILL when it ignores SIGTERM" timed out at
5,015 ms on the macOS runner (issue 297): exactly the `sleep 5` of its script. `runGitProcess`
resolves on `close`, which waits until every holder of git's stdout and stderr pipes is gone. A
stress harness (the real `runGitProcess`, `timeoutMs: 1`, `killGraceMs` 1 to 3 ms, 8 at a time,
20 `yes` on 10 cores) hung 5 times in 12,000 runs, and `ps` during a hang showed the orphan:
`sleep 5` with parent 1, still in the killed process group. A child forked while
`kill(-pgid, SIGKILL)` runs can miss the signal on macOS (XNU). Real git forks helpers
(`git-remote-https`, `index-pack`), so a timed-out or cancelled download could outlive its
timeout and keep running.

## Lesson

One SIGKILL to a process group is not guaranteed to stop every member when the group is still
forking. The surviving child stays in the group, so a second group kill after the leader has
exited reaches it.

## How to apply

- After a group SIGKILL, kill the group once more when the leader's `exit` event arrives
  (`runGitProcess` does this; `runCommand` and `runClaudeProcess` were not checked yet).
- Reproduce a kill race by shrinking the timeout and grace period to 1 to 3 ms and running
  thousands of iterations under load, not by repeating the 50 ms test, which never hit it locally.
- Simulate the missed member in a unit test by spying on `process.kill` so the first group
  SIGKILL reaches only the leader (`kill(-pid)` becomes `kill(pid)`).
