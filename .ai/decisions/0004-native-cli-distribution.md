# ADR-0004: Native npm CLI distribution

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [CLI architecture](../specs/2026-10-14-cli-architecture.md),
  [Local installation](../specs/2026-10-14-local-installation.md),
  [Technology stack](../specs/2026-10-14-technology-stack.md),
  [ADR-0001](0001-local-first-architecture.md), [ADR-0002](0002-sqlite-with-node-sqlite.md),
  [ADR-0003](0003-monorepo-architecture.md)

## Context

The primary install path is `npx directivebench`. The CLI must start a Next.js 16 web UI and a job
runner on the user's machine, and must be able to invoke agent CLIs (`claude`, `codex`,
`cursor-agent`) that the user has already installed and authenticated on the host.

Two packaging questions follow: how to distribute the application at all (native npm vs container),
and how to ship the Next.js server inside an npm package.

Packaging constraints: Next.js `output: "standalone"` produces a self-contained server with
a traced, nested `node_modules`. `npm pack`/`npm publish` exclude nested `node_modules` directories
from the tarball, and in a pnpm workspace the traced dependencies are symlinks into the pnpm store,
which do not survive packing. Shipping standalone output would therefore require copying and
dereferencing dependencies into a non-`node_modules` directory and rewriting resolution, which is
fragile.

## Decision

- Distribute DirectiveBench as a **native npm package** `directivebench` (the only published
  package), run with `npx directivebench` or a global install. Node 24 LTS is the supported runtime;
  `directivebench doctor` validates it.
- **CLI bundle:** `apps/cli` is bundled with **tsup** into `dist/cli.js`, inlining the internal
  just-in-time packages ([ADR-0003](0003-monorepo-architecture.md)).
- **Web UI:** the package ships the **Next.js production build output** (`.next`, copied to
  `dist/web`) together with drizzle migrations and bundled examples. At runtime the CLI spawns
  `next start` as a child process on `127.0.0.1:4280`, passing `DIRECTIVEBENCH_DATA_DIR`.
- `next`, `react` and `react-dom` are **regular runtime `dependencies`** of the `directivebench`
  package, resolved by npm on install, instead of being vendored through standalone output.
- No native modules in the dependency tree (SQLite via `node:sqlite`, see
  [ADR-0002](0002-sqlite-with-node-sqlite.md)), so installs need no compiler or prebuilt binaries.
- Docker images may be offered later as an additional channel (e.g. for self-hosting), not as the
  only one.

## Alternatives considered

- **Docker-only distribution.** Rejected as primary: requires Docker; a container cannot use
  agent CLIs and their credentials installed on the host without mounting the user's home and
  credential stores, which defeats the isolation that motivates containers. Kept as a future option.
- **Next.js standalone output inside the npm package.** Smallest runtime footprint, but nested
  `node_modules` are dropped by `npm pack` and pnpm symlinks break; making it work requires
  post-processing that is easy to get silently wrong.
- **Single executable (Node SEA, pkg, Bun compile).** Next.js server is not designed for single-file
  bundling; per-platform binaries complicate releases.
- **Static export of the UI + custom API server.** Loses server actions and route handlers; would
  duplicate API plumbing.
- **Electron/Tauri desktop app.** Heavier, platform-specific signing and updates; a browser UI is
  sufficient.

## Benefits

- One command to install and run; no Docker or database server.
- Agent CLIs run directly on the host with their existing authentication.
- Standard npm semantics: `npm pack` contents are predictable and testable in CI.
- Next.js runs in its supported production mode (`next start`).

## Drawbacks

- **Larger install:** the full `next` package and its dependencies are installed instead of a traced
  subset; first `npx` run is slower.
- Version coupling: the shipped `.next` build must match the `next` version installed at runtime, so
  `next` must be pinned to an exact version in the CLI manifest.
- Two processes (CLI + Next.js child) to supervise; the CLI must forward signals and clean up.
- Host execution is not sandboxed ([ADR-0007](0007-local-runner-execution-and-isolation.md)).

## Consequences

- The release pipeline must build web, copy the `.next` output (excluding caches) into the CLI
  package, bundle the CLI, and verify the result by installing the packed tarball in a clean
  directory and running `directivebench doctor` and `directivebench demo`.
- `next`, `react`, `react-dom` versions in `apps/cli/package.json` must equal those used to build
  `apps/web`.
- Revisit standalone output if Next.js or npm packaging constraints change.

## Status

Accepted.
