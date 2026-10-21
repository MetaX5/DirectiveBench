---
title: A local pack can contain files a CI pack never sees
date: 2026-10-21
tags: [packaging, npm, release]
source: .ai/runs/2026-10-21-npm-publish-prep.md
---

# A local pack can contain files a CI pack never sees

## Context

Before the first npm publish, `npm pack --dry-run` on a developer machine listed
`dist/examples/node_modules/.vite/vitest/…/results.json`: running the examples' tests had left a
vitest cache in the git-ignored `examples/node_modules`, and `assemble-dist.mjs` copied the whole
`examples/` directory. `pnpm verify:pack` in CI passed, because a fresh checkout has no such cache.

## Lesson

Anything the build copies by directory picks up git-ignored local files. CI only proves the
package of a clean checkout; the package you publish by hand is the one from your working tree.

## How to apply

- Copy directories into `dist` with a filter (no `node_modules`, caches or build output).
- Before a manual `npm publish`, run `pnpm build && pnpm verify:pack` and read
  `npm pack --dry-run` in `apps/cli`; better, publish from CI.
