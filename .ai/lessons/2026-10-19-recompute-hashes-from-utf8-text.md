---
title: Recompute file hashes from stored content, and store only content that passes isUtf8
date: 2026-10-19
tags: [security, hashing, database, core]
source: .ai/runs/2026-10-19-fix-issue-39-recompute-file-sha256.md
---

# Recompute file hashes from stored content, and store only content that passes isUtf8

## Context

Issue #39: `importArtifactVersion` built the manifest hash from per-file `sha256` values supplied
by its caller, so a caller could store file X under file Y's identity (SPEC-103 §12). Re-hashing
the stored `content` was avoided earlier because the legacy `loadLocalArtifact` only skipped
files containing NUL. It decoded invalid UTF-8 with replacement characters, so re-hashing the
decoded string would not give the hash of the source bytes.

## Lesson

Never accept derived values (`sha256`, `size`, content hash) from a caller at the persistence
boundary. Recompute them from what is actually stored. That is only correct when the stored
string round-trips to the source bytes: `Buffer.toString('utf8')` is lossless for valid UTF-8
(BOM and CRLF included) and lossy otherwise. So every loader that produces `content: string`
must reject or skip invalid UTF-8 (SPEC-102 FR-102-17). A NUL check alone is not enough.

## How to apply

- In repository functions, compute `sha256(Buffer.from(content, 'utf8'))` and
  `Buffer.byteLength(content)`, and ignore the caller's values.
- In any new file reader that stores text, use `isBinary` from `@directivebench/core`
  (NUL in the first 8 KiB or `!isUtf8(bytes)`) before decoding. Skip binary supporting files and
  reject a binary primary file.
- Add a test with Latin-1 bytes (e.g. `0xE9`) and a BOM + CRLF file to prove the round trip.
