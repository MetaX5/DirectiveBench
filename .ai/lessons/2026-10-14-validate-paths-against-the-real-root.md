---
title: Validate untrusted relative paths against the directory they must stay in
date: 2026-10-14
tags: [security, filesystem]
source: .ai/runs/2026-10-14-bootstrap-foundation.md
---

# Validate untrusted relative paths against the directory they must stay in

## Context

Artifact installation joined `targetDir` and an artifact-provided file path with
`posix.join()` and then checked that the result stayed inside the workspace. `join()` normalises
`..`, so `../../../outside.txt` silently became a path *inside the workspace but outside the
install directory*. A unit test caught it.

## Lesson

Escape checks must be made against the directory the path is supposed to stay in, after
resolution — not against a broader parent and not on an already-normalised string.

## How to apply

Use `resolveInside(root, relativePath)` from `@directivebench/agent-adapters` with the narrowest
root (e.g. the install directory). Always add a test with `../` segments and absolute paths for
any code that writes files named by untrusted input (artifacts, fixtures, benchmark definitions,
agent playbooks).
