---
title: Bundler defaults break the packed CLI (`node:` prefixes, CommonJS `require` in ESM)
date: 2026-10-14
tags: [build, packaging, sqlite]
source: .ai/runs/2026-10-14-bootstrap-foundation.md
---

# tsup removes `node:` import prefixes by default, which breaks `node:sqlite`

## Context

The bundled CLI worked from source but failed after installing the packed tarball with
`Cannot find package 'sqlite'`. tsup rewrote `import … from 'node:sqlite'` to `'sqlite'`.
Unlike most built-ins, `sqlite` exists **only** with the `node:` prefix.

## Lesson

Tests that run from source do not prove that the published package works. Bundler defaults can
change module specifiers.

## How to apply

- Keep `removeNodeProtocol: false` in `apps/cli/tsup.config.ts`.
- Keep the `createRequire` banner in `apps/cli/tsup.config.ts`: bundled CommonJS dependencies
  (e.g. `yaml`) call `require()`, which does not exist in an ESM bundle
  (`Dynamic require of "process" is not supported`, found on 2026-10-15 when bundling all
  pure-JS dependencies).
- After any change to bundling, dependencies or `apps/cli`, run `pnpm build && pnpm verify:pack`.
