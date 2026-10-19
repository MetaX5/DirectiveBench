---
title: A missing open flag ORs to 0 silently — verify the opened handle's identity instead
date: 2026-10-19
tags: [security, filesystem, windows, testing]
source: .ai/runs/2026-10-19-pr-44-codex-findings.md
---

# A missing open flag ORs to 0 silently — verify the opened handle's identity instead

## Context

The discovery walker opened files with `constants.O_RDONLY | constants.O_NOFOLLOW` to refuse a
file swapped for a symlink after the walk. On Windows `constants.O_NOFOLLOW` is `undefined`, and
`O_RDONLY | undefined` is just `O_RDONLY`: no error, no warning, and the open follows the link.
The Linux test suite could not notice. A Codex review of PR #44 found it. While simulating
Windows in a test, a `Proxy` over `fs.constants` threw an uncoded `TypeError` (a proxy invariant):
`fs.constants` is frozen, so a trap must return the real value of every non-configurable property.

## Lesson

- A platform-specific flag used in a bitwise expression fails open where it is not defined. Do not
  rely on it alone for a safety property.
- To make "the file I read is the file the walk found" hold on every platform: open (with
  `O_NOFOLLOW ?? 0`), `fstat` the handle, `lstat` the path, and require a regular file, no symlink,
  equal `dev` and `ino` (as `bigint`, Windows file IDs are 64-bit), and `ino !== 0n` (no identity
  means fail closed). A link swapped back right after the open is caught by the inode comparison.
- To simulate a missing constant, mock `node:fs` with a copy of `constants` and a getter, not a
  `Proxy` over the frozen original.

## How to apply

When a security check depends on an `fs.constants` flag (`O_NOFOLLOW`, `O_NOATIME`, `O_DIRECTORY`,
`COPYFILE_FICLONE_FORCE`, …), check what it is on Windows, add a platform-independent check that
fails closed, and add a test that runs the code with the flag removed (see
`packages/core/test/discovery-simulated-fs.test.ts`).
