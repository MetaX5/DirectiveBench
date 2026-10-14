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

## How to apply

Use the patterns above in tests and verification scripts (`scripts/verify-pack.mjs` already does).
