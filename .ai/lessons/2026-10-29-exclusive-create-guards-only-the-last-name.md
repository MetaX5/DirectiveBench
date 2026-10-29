---
title: Exclusive create guards only the last name of a path, and undoing a claim must not unlink by path
date: 2026-10-29
tags: [security, filesystem, races, cli]
source: .ai/runs/2026-10-29-agent-run-output-files-export.md
---

# Exclusive create guards only the last name of a path, and undoing a claim must not unlink by path

## Context

`benchmark export` (SPEC-123 Phase 2) wrote untrusted stored paths with `open(path, 'wx')` and
directories with a non-recursive `mkdir`, and claimed its outputs with `manifest.json` (`wx`)
before `files/`. The Codex adversarial review (PR #161, round 1) found two races the tests did not
cover: another process can rename a directory of the chain and put a symbolic link in its place,
and `open` follows every component except the last, so `wx` happily creates the file outside;
and after a lost `files/` claim, `unlink(manifest.json)` removes whatever is at that name by then,
possibly another writer's manifest. A test mock of `lstat` that dropped its options argument also
silently broke the engine's capture in the same test file (the demo run kept no files).

## Lesson

- `wx`/`O_EXCL` and `O_NOFOLLOW` protect the last component only. Without `openat` (Node has
  none), record the `dev`/`ino` of every directory you created or checked, and after `open` but
  before writing, re-`lstat` the whole chain (directory, not a link, same identity) and compare
  `lstat(path)` with `handle.stat()`. A swap can then cost at most an empty file, never content.
- Undo a claim with an operation that cannot destroy someone else's data: create the directory
  first and undo it with `rmdir` (fails unless it is an empty directory); never `unlink` a path
  you created earlier, because ownership of an inode is not ownership of its name.
- A `vi.mock` wrapper of a `node:` function must forward every argument (`...rest`); other
  packages in the same test process call it too.

## How to apply

Any code that writes untrusted names below a directory: create directories 0700 one segment at a
time, files 0600 with `wx`, verify the chain and the handle before writing, and test it with hooks
that rename a directory, replace it with a symbolic link, or replace the opened file right before
the write (`apps/cli/test/benchmark-export.test.ts`).
