---
title: Everything an untrusted setup command can reach outside the pinned workspace reaches the agent
date: 2026-10-22
tags: [security, process, claude-code]
source: .ai/runs/2026-10-22-issue-117-claude-code-adapter.md
---

# Everything an untrusted setup command can reach outside the pinned workspace reaches the agent

## Context

Composing `ClaudeCodeAdapter` (issue #117, PR #119), the workspace was pinned and inspected before
every spawn, yet four Codex rounds each found a path from an approved `setup` command to the
`claude` process (and the API key) that bypassed the inspection: the adapter's scratch directory
(`../agent`, created before `setup`, so `../agent/home/.claude/settings.json` became the API Key
Mode `CLAUDE_CONFIG_DIR`); ancestor instruction files (`../CLAUDE.md`, which Claude Code loads from
above the working directory); the `claude` executable resolved on `PATH` per run (a planted one
earlier on `PATH`), and the interpreter of a `#!/usr/bin/env node` launcher; and relative or empty
`PATH` entries, which resolve against the workspace while `findExecutable` skipped them.

## Lesson

A check of the workspace protects only the workspace. The agent process also reads its working
directory's ancestors, its own home and temp directories, the executable and interpreter `PATH`
selects, and every directory `PATH` names — and `setup` runs with the user's permissions and its
cwd in the workspace, so the run directory around the workspace is writable for it.

## How to apply

- Enumerate every input of the spawned process (cwd and ancestors, each environment variable and
  what it points to, the executable and its `#!` interpreter, `PATH` entries) and, for each, ask
  whether code that ran earlier in the run could have changed it.
- Create run-local directories for the agent **after** untrusted steps, exclusively (`mkdir`
  without `recursive`), and refuse a path that already exists or is a link.
- Pin what must stay trusted before the first untrusted step (`detect()` runs before any `setup`)
  and re-check identity right before each spawn; spawn the canonical path, not a `PATH` lookup.
- Keep a child's `PATH` to absolute entries; keep the lookup used for pinning identical to the one
  the child (or `env`) performs.
- Write the regression as an engine test where `setup` plants the thing, and prove it red first.
