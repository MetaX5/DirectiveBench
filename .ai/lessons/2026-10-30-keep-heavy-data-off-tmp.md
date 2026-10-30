---
title: Keep worktrees and large data off /tmp, and clean up after every run
date: 2026-10-30
tags: [agents, environment, tmpfs]
source: maintainer correction, 2026-10-30
---

# Keep worktrees and large data off /tmp, and clean up after every run

## Context

On 2026-10-29, while several agents worked on SPEC-123 in parallel, the maintainer's machine ran
out of memory. `/tmp` there is a `tmpfs` (RAM, 16 GB), and it had grown past 10 GB. These wrote
into it:

- the orchestrating agent, which put git worktrees with `pnpm install`, a cloned repository and a
  test data directory in its scratchpad (`/tmp/claude-<uid>/…`);
- agent transcripts;
- repeated `pnpm verify:pack` runs (each installs the packed CLI with `next` into
  `os.tmpdir()`), benchmark workspaces (`<tmpdir>/directivebench/workspaces`) and test temp
  directories that interrupted runs left behind.

## Lesson

`/tmp`, and any agent scratchpad under it, can be RAM. Large or long-lived data there competes
with the processes the gate needs. Running agents in parallel is fine; leaving data behind is not.

## How to apply

- Worktrees go to `.ai/tmp/` (git-ignored), never to `/tmp` or a scratchpad. Clones, data
  directories, builds and `node_modules` also stay on disk.
- Before finishing, also after a failure, remove every worktree, temporary directory, data
  directory and server you created. Say so in every subagent brief.
- Locally, `TMPDIR` can point at a disk directory (for Claude Code:
  `"env": { "TMPDIR": "…" }` in `.claude/settings.local.json`), because `os.tmpdir()` follows it.
- Check `du -sh /tmp/* "$TMPDIR"/*` at the end of a long session.
- Since 2026-10-30, `pnpm verify:pack` removes its directory (about 350 MB) on every exit
  (`--keep` keeps it), and the Playwright run removes its one temporary root. Before that,
  every `verify:pack` run left about 350 MB behind, which is where most of the 10 GB came from.
