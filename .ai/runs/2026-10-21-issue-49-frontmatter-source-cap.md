---
title: Cap the frontmatter block before the YAML parse (issue #49)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request — om-auto-fix-issue 49
status: completed
branch: fix/issue-49-cap-frontmatter-source-bytes
specs: [SPEC-102]
---

# Run: Cap the frontmatter block before the YAML parse (issue #49)

## Objective

Issue #49: `parseFrontmatter` passed the whole frontmatter block (up to the 1 MiB primary-file
limit) to `yaml`'s `parse`, whose duplicate-key check is quadratic, blocking the runner's event
loop. Acceptance criteria: a 1 MiB block with many keys is rejected quickly as invalid
frontmatter without calling `parse` (tested); the cap is justified in the code and in SPEC-102
§12; 100% coverage.

## Plan

Bug route of `om-auto-fix-issue`: `om-verify-in-repo` → `om-root-cause` → `om-fix` →
`om-open-pr` → `om-auto-review-pr`. One named cap checked before `parse`, treated as invalid
frontmatter (FR-102-05); keep `uniqueKeys` on; keep `MAX_FRONTMATTER_JSON_BYTES`.

## Decisions

- **Cap value 64 KiB** (`MAX_FRONTMATTER_SOURCE_BYTES`), the low end of the issue's 64–256 KiB
  range. Measured `yaml.parse` on a flat mapping of `kN: 1` keys (macOS laptop, Node 24):
  16 KiB 31 ms, 32 KiB 71 ms, 64 KiB 207 ms, 128 KiB 999 ms, 256 KiB 2980 ms (with
  `uniqueKeys: false`: 12/18/61/58/128 ms). 64 KiB keeps one block to ~0.2 s on the event loop;
  256 KiB would still allow 3 s per file. Real frontmatter is a few hundred bytes.
- **Counted in UTF-8 bytes** (`Buffer.byteLength`), like the other byte limits.
- **Warning text** `frontmatter is longer than 65536 bytes`, shown as
  `Invalid frontmatter: …` (FR-102-05); it never quotes the content.
- The two existing aliased-size tests used a ~1 MB source, now over the cap; they use a 60 kB
  string (and a 41 900-character chunk for the exact-limit test), which still expands past
  `MAX_FRONTMATTER_JSON_BYTES`, so they keep testing the JSON cap.

## Work performed

1. Reproduced the quadratic parse time (measurements above).
2. `packages/core/src/frontmatter.ts`: `MAX_FRONTMATTER_SOURCE_BYTES` and the check before
   `parse`.
3. Tests: `packages/core/test/frontmatter.test.ts` (cap boundary with multi-byte text; 1 MiB
   block of >100 000 keys rejected in < 1 s with a spied `parse` never called; aliased-size tests
   resized), `packages/runner/test/repository-scan.test.ts` (scan stores an over-cap skill with
   empty frontmatter, the warning and the directory-name fallback; aliased test resized).
4. SPEC-102 FR-102-05, §12 and §20 updated; lesson recorded.

## Verification

- New tests fail on the previous code (3 failed: boundary, 1 MiB block, the scan test timed out
  after 5 s) and pass with the fix.
- `pnpm format:check` ✅, `pnpm lint` ✅, `pnpm typecheck` ✅, `pnpm build` ✅,
  `pnpm verify:pack` ✅ (Packaging verification passed).
- `pnpm test`: core, database, agent-adapters, benchmark-engine, web and CLI pass at 100%
  coverage (`frontmatter.ts` 100%). `@directivebench/runner` had 2 failures locally, both
  unrelated to this change:
  - `hosted-repository.test.ts` › "rejects a file name that is not valid UTF-8" — `EILSEQ`: macOS
    APFS refuses a non-UTF-8 file name; it fails the same way with the previous
    `frontmatter.ts`.
  - `hosted-git.test.ts` › blob-fetch failures — a `timeout` instead of `auth-required` under the
    parallel full-suite load; the file passes alone (45/45).
  Runner coverage was 99.4% only because of those two failures. CI (Linux) is the authority.
- Real input via `parseFrontmatter` from source: a 1 073 KiB block of 110 000 keys is rejected in
  0.6 ms; ordinary frontmatter parses unchanged.
- Not verified: a scan through the running CLI/UI (the runner integration test covers the scan
  path end to end against SQLite).

## Problems and deviations

- `pnpm` was not on `PATH`; used `corepack pnpm` and a scratchpad shim for scripts that call
  `pnpm` recursively.
- **Human correction:** PR #84 was first opened with `om-open-pr`'s default body template and
  `skip-qa`. A reviewer pointed out that it did not match the maintainer's PR layout. The body was
  rewritten in the house layout (as in #68, #71–#73), `skip-qa` was replaced by `needs-qa`, and the
  rule was added to `AGENTS.md` §4 and recorded as a lesson.

## Lessons recorded

- [2026-10-21-cap-input-before-a-superlinear-sync-parse.md](../lessons/2026-10-21-cap-input-before-a-superlinear-sync-parse.md)
- [2026-10-21-pr-bodies-follow-the-house-layout.md](../lessons/2026-10-21-pr-bodies-follow-the-house-layout.md)

## Follow-ups

- Worst case per scan is still ~0.2 s × up to 10 000 candidates (`maxCandidatesPerScan`); between
  files discovery awaits I/O, so heartbeats and cancellation are observed. A scan-wide parse-time
  bound was not added (out of scope for #49).
- The macOS `EILSEQ` failure in `hosted-repository.test.ts` makes `pnpm test` red on macOS
  (candidate for a `skipIf` on file systems that reject non-UTF-8 names).
