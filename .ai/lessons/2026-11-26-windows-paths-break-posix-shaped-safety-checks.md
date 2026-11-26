---
title: A safety check that relies on POSIX path shapes or POSIX rename semantics fails open on Windows
date: 2026-11-26
tags: [security, windows, file-system, claude-code]
source: .ai/runs/2026-11-26-claude-code-windows-workspace-checks.md
---

# A safety check that relies on POSIX path shapes or POSIX rename semantics fails open on Windows

## Context

Issue #302. The first Windows run of `packages/agent-adapters` (run 44632322366) showed two
fail-open gaps in the Claude Code workspace checks:

- the `@` import scanner classified a token as absolute only when it started with `/`, so
  `@C:\Users\…\secret` and `@\\server\share\f` were treated as relative and never resolved; the
  `..` and repeated-separator detection also looked only at `/`;
- the install relied on `rename` failing on an occupied destination. On Windows `rename`
  (`MoveFileEx`) **replaces a file** at the destination and fails with **`EPERM`** (not
  `EEXIST`/`ENOTEMPTY`) on a directory, so a `.claude` file was silently replaced and a
  `.claude` directory produced a raw `EPERM` instead of `artifact-install-conflict`.

## Lesson

A path or file-system safety check written against POSIX behaviour fails open on Windows:
absolute paths there also start with a drive letter (`X:\`, `X:/`) or `\` (UNC, drive-rooted),
`\` is a separator, and `rename` overwrites files and reports occupied directories as `EPERM`.

## How to apply

- When a check decides whether a path is absolute, relative or climbing, handle Windows shapes
  on every platform (test the classifier on Linux too) and treat `\` as a separator.
- Never rely on `rename` failing to detect an occupied destination: `lstat` first, keep the
  post-move identity check for races, and map `EPERM` to "occupied" only when the destination
  now exists, so a real permission error still propagates.
- Simulate the Windows behaviour in a Linux test with a `rename` hook (`races.test.ts`), so the
  regression runs where the 100% coverage gate runs.
