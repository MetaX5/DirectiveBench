---
title: turbo needs a `pnpm` binary on PATH; `corepack pnpm` alone fails with a misleading error
date: 2026-11-19
tags: [tooling, build]
source: .ai/runs/2026-11-19-issue-55-content-tab-relative-links.md
---

# turbo needs a `pnpm` binary on PATH; `corepack pnpm` alone fails with a misleading error

## Context

On a machine where `pnpm` was not on `PATH` (neither `~/.local/share/pnpm/bin` nor a global
install), `corepack pnpm install` and `corepack pnpm lint` worked, but `corepack pnpm typecheck`
failed at once with `x Unable to find package manager binary: cannot find binary path`. The
message names no package and no command: it comes from `turbo`, which looks up the
`packageManager` binary (`pnpm`) on `PATH` itself instead of going through corepack.

## Lesson

Every root script that runs `turbo` (`typecheck`, `test`, `build`, `test:e2e` through its build)
needs a real `pnpm` executable on `PATH`; `corepack pnpm <script>` is not enough.

## How to apply

When `pnpm` is missing, put a two-line shim outside the repository and outside `/tmp`, e.g.
`/var/tmp/<run>/bin/pnpm` containing `#!/bin/sh` and `exec corepack pnpm "$@"`, make it
executable, prepend its directory to `PATH` for the gate commands, and remove it with the run's
other temporary data.
