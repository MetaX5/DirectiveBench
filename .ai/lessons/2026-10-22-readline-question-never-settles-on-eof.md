---
title: readline/promises question() never settles when input ends; race it against close
date: 2026-10-22
tags: [cli, node, readline, testing]
source: .ai/runs/2026-10-22-issue-97-benchmark-cli.md
---

# readline/promises question() never settles when input ends; race it against close

## Context

`benchmark run` asked for confirmation with `prompt.question(...).catch(() => '')`, assuming an
unreadable answer rejects. Ctrl-C does reject (`AbortError`), but on end of input (Ctrl-D, a
closed or piped-empty stdin) readline emits `close` and the `question()` promise stays pending
forever: the command hung, Node exited 13 on the unsettled top-level await, and the `finally`
that removes staged fixture copies never ran (Codex adversarial review round 2 of PR #118). The
tests covered `y`, `n`, an empty line and Ctrl-C, never EOF.

## Lesson

In `node:readline/promises`, `question()` is settled only by an answer or an abort signal, not by
the interface closing. Any prompt must race `question()` against the interface's `close` event,
and a cleanup in `finally` is only as reliable as every awaited promise before it.

## How to apply

- Wrap prompts as `Promise.race([rl.question(q).catch(() => ''), closed])` with
  `closed = new Promise((r) => rl.once('close', () => r('')))`, then `rl.close()` in `finally`
  (see `askYesNo` in `apps/cli/src/benchmark-run.ts`).
- Test every prompt with an ended input stream (`stream.end()`) and with `'\x04'` on a TTY-like
  output, and assert the cleanup that follows it, not only the answer.
