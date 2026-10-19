---
title: Canonicalise every entry of a path deny-list, including the ones added later
date: 2026-10-19
tags: [security, filesystem, discovery]
source: .ai/runs/2026-10-19-pr-44-second-codex-review.md
---

# Canonicalise every entry of a path deny-list, including the ones added later

## Context

`userLevelAgentFolders` (PR #44, D05) resolved the current user's agent folders with `realpath`
so that a dotfiles symlink (`~/.codex` → `~/dotfiles/codex`) is skipped under both spellings. The
sibling homes' folders were appended afterwards as literal paths. The walker compares canonical
directory paths and never follows symlinks, so with `/home/bob/.claude` →
`/home/dotfiles/bob-claude`, a scan of `/home` skipped the link but walked the real target.

## Lesson

A deny-list matched against canonical paths is only as strong as its weakest entry: every entry
must be listed both as spelled and as it resolves. Build the complete list first and resolve it in
one place, so an entry added later cannot bypass the resolution step.

## How to apply

- Assemble all candidate paths, then map the whole list through `realpath` (keeping the literal
  spelling as well) right before returning it.
- Test each source of entries with a symlink whose target lies inside the scanned tree
  (`packages/runner/test/repository-scan.test.ts`, "skips a sibling home's agent folder under its
  symlink target inside an ancestor scan").
