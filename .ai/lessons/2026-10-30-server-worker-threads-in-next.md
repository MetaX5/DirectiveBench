---
title: A Node worker thread in the Next.js server needs the literal new Worker(new URL()) form and no server-only
date: 2026-10-30
tags: [build, next, worker-threads, testing]
source: .ai/runs/2026-10-30-agent-run-output-files-syntax-highlighting.md
---

# A Node worker thread in the Next.js server needs the literal `new Worker(new URL())` form and no `server-only`

## Context

SPEC-123 FR-123-78 runs Shiki in a terminable `node:worker_threads` worker so a synchronous
`RegExp.exec` can be stopped. The worker entry had to be bundled into the Next.js 16.4
(Turbopack) server build and run from the installed CLI tarball, and the unit tests had to run
the same entry in a real thread.

## Lesson

- Turbopack bundles a server worker for the literal expression
  `new Worker(new URL('./entry.ts', import.meta.url))` with `Worker` from `node:worker_threads`
  (other forms, such as a URL kept in a variable, were not tried and are unlikely to be traced):
  it emits a `[worker thread]-…` chunk in `.next/server/chunks/ssr` with every import bundled
  (including packages Next keeps external by default), and it works in `next dev`, `next start`
  and the packed CLI. It also copies the entry's source to `.next/static/media/<entry>.<hash>.ts`
  as an unreferenced asset: keep the entry free of anything that must not be public.
- The worker is not a React Server Component context: do not import `server-only` (or anything
  that does) from the worker's module graph. Keep the server-only module as the only importer of
  the worker URL.
- With `allowImportingTsExtensions` and explicit `./x.ts` specifiers in the worker's module graph
  (plain, type-strippable TypeScript, no path aliases), Node 24 runs the unbuilt entry in a real
  thread from Vitest, so tests exercise the real worker. Coverage of code that runs only inside a
  thread is not collected: test the entry's handler in-process too.
- Mocks (`vi.mock`, `vi.spyOn(Date, 'now')`) do not reach a worker thread: keep deterministic
  tokenizer tests on the in-process function and use small `eval: true` workers to stand in for
  a stalled tokenizer.
- A real worker's cold start (thread, module loading, Shiki highlighter creation) took over 2 s
  on a loaded CI runner although it took about 200 ms locally: a test of a real worker behind a
  wall-clock deadline must freeze that clock (`vi.useFakeTimers({ toFake: ['setTimeout',
  'clearTimeout', 'performance'] })`, with the code reading the global `performance`, not the
  `node:perf_hooks` export) and test the deadline with stand-in workers.

## How to apply

Check `.next/server/chunks/ssr` for the `[worker thread]` chunk after `pnpm build`, and make
`pnpm verify:pack` exercise the worker from the installed tarball.
