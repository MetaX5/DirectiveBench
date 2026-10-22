---
title: Parallel agents of one session share the scratchpad — give every temp file a run-unique name
date: 2026-10-22
tags: [agents, process, github]
source: .ai/runs/2026-10-22-ab-baseline-storage.md
---

# Parallel agents of one session share the scratchpad — give every temp file a run-unique name

## Context

Issues #94 and #95 were implemented in parallel by two agents of the same Claude Code session,
each in its own git worktree. Both wrote their PR description to the session scratchpad as
`pr-body.md`. The #94 agent overwrote the file between the #95 agent's write and its
`gh pr edit 106 --body-file …/pr-body.md`, so PR #106 briefly carried #94's description. A
Python check that edited the file first failed, which is how it was noticed; the body was
restored from a uniquely named file.

## Lesson

Separate worktrees isolate the repository, not the scratchpad: every agent of a session gets the
same scratchpad directory. A fixed temp-file name (`pr-body.md`, `review.md`, `gate.log`) is
shared state between parallel agents, and a write followed later by a read can pick up the
other agent's content.

## How to apply

When agents run in parallel, write temp files under a run-specific subdirectory or name
(`<scratchpad>/issue-95/pr106-body.md`), never a generic name. Before publishing a file to the
tracker (`--body-file`), check it is yours (e.g. its `Tracking plan:` line or the PR number), and
after editing a PR body read it back with `gh pr view --json body`.
