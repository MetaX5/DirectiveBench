---
title: Vitest's default include also collects test files inside build output
date: 2026-10-15
tags: [testing, build]
source: .ai/runs/2026-10-15-resolve-spec-code-gaps.md
---

# Vitest's default include also collects test files inside build output

## Context

After `pnpm build`, `pnpm test` failed in `apps/cli`: Vitest picked up
`dist/examples/benchmarks/*/verification/test/*.test.js` — fixture tests that belong to the mock
benchmark and are meant to run with `node --test` inside a benchmark workspace. CI did not notice
because it runs the tests before the build.

## Lesson

Vitest's default `include` covers every `*.test.*` file in the package except `node_modules`, so
any package that copies example or fixture files into its build output can run them by accident.

## How to apply

Packages whose build output may contain `*.test.*` files must restrict Vitest explicitly (see
`apps/cli/vitest.config.ts`: `include: ['test/**/*.test.ts']`). When verifying locally, run
`pnpm test` after `pnpm build` as well.
