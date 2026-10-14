---
title: Current toolchain constraints (TypeScript, ESLint, Drizzle, pnpm)
date: 2026-10-14
tags: [tooling, dependencies]
source: .ai/runs/2026-10-14-bootstrap-foundation.md
---

# Current toolchain constraints (TypeScript, ESLint, Drizzle, pnpm)

## Context

Picking the newest version of every tool produced incompatible combinations during the bootstrap.

## Lesson

- `typescript-eslint` 8.x supports TypeScript `<6.1`, so the repo uses TypeScript 6.0 (not 7).
- `eslint-plugin-react` (used by `eslint-config-next`) does not support ESLint 10; the repo uses
  ESLint 10 with `@next/eslint-plugin-next` and `eslint-plugin-react-hooks` directly.
- Drizzle ORM 0.45 (stable) has no `node:sqlite` driver; `packages/database` wraps `node:sqlite`
  with Drizzle's `sqlite-proxy` driver. `StatementSync#setReturnArrays` requires Node >= 22.16.
- pnpm 12 blocks dependency build scripts until approved (`allowBuilds` in
  `pnpm-workspace.yaml`) and enforces a minimum release age (`minimumReleaseAgeExclude`).
- On the maintainer's machine pnpm lives in `~/.local/share/pnpm/bin`, which may not be on
  `PATH` in non-interactive agent shells.

## How to apply

Check peer-dependency ranges (`npm view <pkg> peerDependencies`) before upgrading TypeScript,
ESLint or Drizzle, and re-run `pnpm lint && pnpm typecheck && pnpm test`. If `pnpm` is not
found, prepend `~/.local/share/pnpm/bin` to `PATH` instead of installing another copy.
