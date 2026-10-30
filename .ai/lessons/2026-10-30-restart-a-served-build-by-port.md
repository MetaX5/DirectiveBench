---
title: Check that a manual server really restarted before you verify a new build
date: 2026-10-30
tags: [testing, processes, verification]
source: .ai/runs/2026-10-30-agent-run-output-files-compare.md
---

# Check that a manual server really restarted before you verify a new build

## Context

During the SPEC-123 Phase 4 real-app check, the built CLI was started with
`cd <worktree> && ... nohup node apps/cli/dist/cli.js serve --port 4417 & echo $! > serve.pid`.
`$!` was the pid of the shell running the `&&` chain, not of the `node` process, and
`directivebench serve` also starts a separate `next-server` child. After the browser QA fixes
were rebuilt, `kill $(cat serve.pid)` killed only that shell. The new `serve` exited with
"Port 4417 on 127.0.0.1 is already in use", but the health check still passed against the old
server, so the page looked as if the fixes had not worked. The e2e suite, which starts its own
server, passed.

## Lesson

A health check on a fixed port proves only that *some* server answers. It does not prove that
the build you just made is the one serving. A pid from `$!` after a compound command may
belong to a wrapper shell, and the CLI's Next.js server is a child process with its own pid.

## How to apply

- Before checking a rebuilt app by hand, stop the old server by its port: find the pids with
  `ss -ltnp | grep <port>` (or `pgrep -f "port <port>"`) and kill both the CLI process and its
  `next-server` child. Confirm the port is free, then start the new server.
- After starting the new server, read its log for "already in use", or request a page whose
  output only the new build produces, before you trust the result.
- At the end of the run, stop every server you started the same way, and list it in the
  cleanup report.
