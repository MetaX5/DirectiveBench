---
title: A web client component must not import @directivebench/core; pass limits and copy as props
date: 2026-11-05
tags: [web, nextjs, build]
source: .ai/runs/2026-11-05-category-pages.md
---

# A web client component must not import @directivebench/core; pass limits and copy as props

## Context

SPEC-124 Phase 2's `app/categories/category-forms.tsx` (`'use client'`) imported
`CATEGORY_NAME_MAX_LENGTH` from `@directivebench/core` and two copy helpers from
`lib/categories.ts`, which itself imports core. `pnpm typecheck`, `pnpm lint` and the unit tests
passed; `pnpm build` panicked in Turbopack with "Failed to write app endpoint /categories/page …
the chunking context (unknown) does not support external modules (request: node:fs)" and wrote
a panic log to `/tmp`.

## Lesson

`@directivebench/core`'s entry point pulls in Node built-ins, so nothing it reaches can be
bundled for the browser. Type-only imports (`import type`) are erased and are fine; value
imports of core, or of a `lib/` module that imports core values, are not. The error names the
route, not the import, and only `next build` shows it.

## How to apply

- In a `'use client'` file under `apps/web`, import only types from `@/lib/*` modules that use
  core; compute limits and counted copy in the Server Component and pass them as props (as
  `metadata-forms.tsx` does with `maxTags`, `maxLength`).
- Run `pnpm build` after adding a client component, before e2e, and remove the panic log it
  leaves in `/tmp`.
