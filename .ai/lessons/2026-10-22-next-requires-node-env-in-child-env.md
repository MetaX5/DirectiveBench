---
title: Next.js makes `NODE_ENV` required in `ProcessEnv` — a package the web app imports fails only the web typecheck
date: 2026-10-22
tags: [typescript, nextjs, build]
source: .ai/runs/2026-10-22-issue-102-claude-code-readiness.md
---

# Next.js makes `NODE_ENV` required in `ProcessEnv` — a package the web app imports fails only the web typecheck

## Context

`packages/agent-adapters/src/probe.ts` built an allowlisted child environment typed as
`NodeJS.ProcessEnv` and passed it to `execFile`. The package's own `tsc` passed, but
`pnpm typecheck` failed in `@directivebench/web` with "Property 'NODE_ENV' is missing in type
'{ NO_COLOR: string; }'", because the web app type-checks the workspace packages it imports
with Next.js's global types, which declare `NODE_ENV` as a required `ProcessEnv` member.

## Lesson

A workspace package the web app imports is type-checked twice, once with Next.js's
augmentation of `NodeJS.ProcessEnv`. An environment object built from an allowlist cannot be
typed as `ProcessEnv` there unless it contains `NODE_ENV`.

## How to apply

Type such objects as `Record<string, string>` (as `buildCommandEnv` does) and, where an option
requires `ProcessEnv`, widen at the call with a comment naming the reason. Always run the root
`pnpm typecheck`, not only the package's own, after touching code the web app imports.
