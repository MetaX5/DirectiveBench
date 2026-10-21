---
title: git canonicalises tree entry modes on read — test unusual modes with raw tree objects
date: 2026-10-21
tags: [git, testing, repository-sync]
source: .ai/runs/2026-10-21-issue-61-hosted-fetch-deviations.md
---

# git canonicalises tree entry modes on read — test unusual modes with raw tree objects

## Context

PR #51 documented that "a tree entry with an unusual file mode (e.g. a legacy `100664`) fails the
whole hosted scan", because `listSnapshot` rejects any mode other than `100644`, `100755`,
`120000` and `160000`. Issue #61 asked to fix it. A first fixture built with `git mktree` could not
reproduce it: `mktree` normalises the modes it is given. A raw tree written with
`git hash-object -t tree --literally -w` does keep `100664`, but `git ls-tree -r` (and even
`git cat-file -p`) still print `100644`: git runs every mode through `canon_mode` when it decodes a
tree — `100664`/`100600`/`100000` become `100644`, a symlink-like mode `120000`, anything else
(`644`, `140000`, `777777`) a `160000` gitlink. So the "deviation" could not happen with a real
repository; only fake git output reaches that branch.

## Lesson

Before "fixing" behaviour on unusual git data, reproduce it with the raw object and the exact
command the code runs: git's porcelain and plumbing both normalise tree modes, so most of the
mode space never reaches the parser. Only `git cat-file tree <oid>` shows the stored bytes.

## How to apply

- Craft trees with `hash-object -t tree --literally -w --stdin` from
  `<mode> <name>\0<20-byte oid>` entries (sorted by name), not with `mktree`, and assert the stored
  bytes with `cat-file tree` so the fixture is proven armed.
- Assert what `ls-tree -r -z --full-tree` actually prints for the fixture, then the scan result
  (`packages/runner/test/hosted-repository.test.ts`, "legacy or unusual modes").
- Keep a parser's fail-closed branch for output git does not produce; test it with the fake git.
