---
title: node:sqlite on Node 22 truncates TEXT at the first NUL on read, so stored text never holds U+0000
date: 2026-11-19
tags: [database, node, sqlite, compatibility]
source: .ai/runs/2026-11-19-issue-265-nul-text-on-node-22.md
---

# node:sqlite on Node 22 truncates TEXT at the first NUL on read, so stored text never holds U+0000

## Context

Issue #265, found while adding the `oldest-node` CI job (#263): a CLI export test stored the
path `nul\0.txt` and read back `nul` on Node 22.16.0. SQLite stores the whole value
(`length(cast(x as blob))` is 8), but Node 22's `node_sqlite.cc` builds the JS string with
`String::NewFromUtf8(isolate, text)` and no length, so it stops at the first NUL. Every Node 22
release up to 22.23.5 does this; nodejs/node#61954 (a performance change that passes
`sqlite3_column_bytes` as the length) fixed it in Node 24.16.0 and Node 26 only. Node 22 has no
`StatementSync` option to read TEXT as bytes, so the Drizzle proxy cannot repair reads.

Untrusted text reaches U+0000 without a NUL byte in the file: YAML double-quoted `"\0"` in
frontmatter. Valid UTF-8 may also hold U+0000 after the first 8 KiB that `isBinary` reads.

## Lesson

- The database client refuses any string parameter holding U+0000 (`NulInTextError`, thrown in
  the `sqlite-proxy` callback and wrapped by Drizzle as the query error's `cause`). Text with
  NUL must be handled before it reaches a repository function.
- JSON columns (`mode: 'json'`) are safe: `JSON.stringify` writes `\u0000` as an escape.
- Error and message columns pass through `storedMessage` (U+0000 becomes U+FFFD) so a failure is
  still recorded; frontmatter `name`/`description` holding NUL are ignored with a warning.
- PostgreSQL also refuses NUL in text, so the rule holds for a future second backend.

## How to apply

- A new plain TEXT column fed from agent output, process errors or imported content: either
  validate it (reject NUL with a clear message at the boundary), keep it in a JSON column, or
  pass it through `storedMessage` if it is an error or message.
- Run the database and runner tests on Node 22.16.0 (the `oldest-node` CI job) when touching
  text storage; Node 24.16+ hides this bug.
