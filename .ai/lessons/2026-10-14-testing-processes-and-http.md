---
title: Pitfalls when testing CLI processes and HTTP behaviour
date: 2026-10-14
tags: [testing, processes, http]
source: .ai/runs/2026-10-14-bootstrap-foundation.md
---

# Pitfalls when testing CLI processes and HTTP behaviour

## Context

Several false failures happened while verifying the server and CLI during the bootstrap.

## Lesson

- `fetch()` silently ignores a custom `Host` header (it is a forbidden header). Host/DNS-rebinding
  checks must use `node:http` `request()` or `curl -H 'Host: …'`.
- `npx`/`npm exec` does not forward a `SIGINT` sent only to its own PID. Signal the real node
  process, the process group, or run the built `dist/cli.js` directly.
- `pkill -f <pattern>` also matches the shell running the command when the pattern appears in
  its own command line — it can kill the agent's shell. Kill by PID instead.
- In YAML flow sequences (`[a, b]`) unquoted commas split items. Quote argv elements that contain
  commas, e.g. `'--sniffs=A,B,C'`.
- (2026-10-16) A child process's environment is not exactly what the parent passed: macOS adds
  `__CF_USER_TEXT_ENCODING` to every process. And a developer's `PATH` can be close to 1 KB, so
  a test that prints the whole environment can exceed a small `maxOutputBytes` and be truncated.
  Both made the `runCommand` environment test fail on macOS while CI (Linux) stayed green.
- (2026-10-19) `vi.waitFor` gives up after 1000 ms by default. Polling for "the process is
  running" with it is a hidden timeout: `serve()` does real I/O (migrations, port check, runner
  start) before it registers SIGINT, and the first, cold test in a file sometimes took longer on a
  loaded CI runner while all packages ran in parallel (#38). Locally the same step took ~60 ms.

## How to apply

Use the patterns above in tests and verification scripts (`scripts/verify-pack.mjs` already does).
When a test inspects a child's environment, print variable names rather than values, and filter
the OS-injected names explicitly with a comment (see `OS_INJECTED_ENV` in
`packages/benchmark-engine/test/commands.test.ts`). Do not loosen the check to "contains": an
unexpected inherited variable must still fail the test.
To wait until a long-running command is ready, await a real signal (an event, a promise or a
listener registration via `newListener`, as `FakeProcess.running` in
`apps/cli/test/serve.test.ts` does) instead of polling `vi.waitFor` with its default timeout.
If polling is unavoidable, pass a named, generous `timeout`.
A fake executable written in Node must not call `process.exit()` right after
`process.stdout.write()` when stdout is a pipe: the exit drops what is still buffered (a 2 MB
answer arrived truncated, #18). Exit in the write callback instead.
