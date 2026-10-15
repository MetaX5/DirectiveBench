---
title: no-restricted-imports group negations cannot re-include a subpath of an excluded package
date: 2026-10-15
tags: [lint, tooling]
source: .ai/runs/2026-10-15-engineering-standards.md
---

# `no-restricted-imports` group negations cannot re-include a subpath of an excluded package

## Context

While enforcing the package dependency direction, the web rule used
`group: ['@directivebench/*', '!@directivebench/benchmark-engine/definition', …]`. ESLint then
reported the allowed subpath imports (`@directivebench/benchmark-engine/load`, `/scoring`,
`/definition`) as violations.

## Lesson

`group` patterns use gitignore semantics: `@directivebench/*` excludes the "directory"
`@directivebench/benchmark-engine`, and gitignore cannot re-include a file whose parent is
excluded, so the negation has no effect. A second, related pitfall: in flat config a later
`no-restricted-imports` entry for the same files replaces the earlier options instead of merging.

## How to apply

For "only these internal packages or subpaths" rules use the pattern's `regex` option (see
`onlyInternal` in `eslint.config.mjs`), keep each file glob in exactly one
`no-restricted-imports` block, and prove a new rule with a temporary file containing both allowed
and forbidden imports before relying on it.
