# @directivebench/web

The local DirectiveBench web UI (Next.js App Router). It is started by the `directivebench`
CLI, which sets `DIRECTIVEBENCH_DATA_DIR`, migrates the database and runs the job runner.

- Server Components read SQLite through `@directivebench/database` repository functions.
- Server Actions only enqueue or cancel jobs; benchmarks are executed by the runner in the CLI
  process, never by the web server.
- `proxy.ts` rejects requests whose `Host` header is not an allowed local host (DNS-rebinding
  protection).

Develop with `pnpm dev` from the repository root (starts the CLI in dev mode, which runs
`next dev` and the runner). See `.ai/specs/features/dashboard-and-navigation.md`.
