---
title: Issue 265, node:sqlite on Node 22 truncates TEXT values at the first NUL on read
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #265, maintainer-approved om-auto-fix-issue run (two phases, stop after analysis)
status: in-progress
branch: fix/issue-265-nul-text-on-node-22
specs: [SPEC-004, SPEC-006, SPEC-102]
---

# Run: Issue 265, NUL in TEXT values on Node 22

## Objective

Issue #265: on Node 22, `node:sqlite` returns a TEXT value only up to its first NUL character.
Done when no TEXT value is silently truncated on any supported Node (regression test in the
`oldest-node` CI job) and `apps/cli` unit tests run in that job (added by PR #267).

Phase A (this entry): reproduce, find which columns and inputs are affected, check upstream,
write the options and a recommendation, then stop for the maintainer's decision. Phase B
(implementation) starts only after that decision and after PR #267 is merged.

## Plan

1. Reproduce on Node 22.16.0, 22.23.2, 22.23.5 and 24.21.0 with raw `node:sqlite` and through
   the `packages/database` Drizzle `sqlite-proxy` client.
2. Audit which TEXT columns can receive NUL from untrusted input.
3. Check the upstream Node fix and whether Node 22 has it.
4. Options with trade-offs, recommendation, stop.

## Decisions

Maintainer decision (relayed 2026-11-19), options B + C of the phase A analysis:

- Keep the Node 22.16 floor (no ADR needed).
- B: the `sqlite-proxy` callback refuses a string parameter holding U+0000 with `NulInTextError`.
- C: frontmatter `name`/`description` holding U+0000 are invalid values (warning, usual
  fallback); NUL in error and message text becomes U+FFFD through one helper (`storedMessage`)
  at the repository write boundary.
- Web Zod schemas (`apps/web/lib`) are out of scope until the #123 PR merges (follow-up).

Made without asking: a first `# ` heading holding U+0000 is not used as a fallback description
(same rule as frontmatter, no warning because it is only a fallback); rule 3 linking
(`isLinkable`) treats a `SKILL.md` name with NUL as no name, matching the parser.

## Work performed

### Reproduction (phase A)

Raw `node:sqlite` probe (`insert ... values (?)` with `'nul\0.txt'`, then read):

| Node | SQLite | `all()` / `get()` / `iterate()` / arrays | `length(x)` / `length(cast(x as blob))` | `cast(x as blob)` read | `where x = ?` full value |
| --- | --- | --- | --- | --- | --- |
| 22.16.0 | 3.49.1 | `nul` (truncated) | 3 / 8 | full bytes | matches |
| 22.23.2 | 3.51.3 | `nul` (truncated) | 3 / 8 | full bytes | matches |
| 22.23.5 (latest 22.x) | 3.54.1 | `nul` (truncated) | 3 / 8 | full bytes | matches |
| 24.21.0 | 3.53.4 | `nul\u0000.txt` | 3 / 8 | full bytes | matches |

SQLite stores the full value; only the conversion to a JS string truncates. JSON text written
with `JSON.stringify` holds `\u0000` as an escape, not a NUL byte, so `mode: 'json'` columns
are not affected.

Through the database client (`openDatabase(':memory:')`, Drizzle `sql` insert and select), a
frontmatter `name: "evil\0hidden"` parsed by `parseFrontmatter` reads back as `evil` on 22.16.0
and as `evil\u0000hidden` on 24.21.0; the JSON copy of the same frontmatter is intact on both.

`apps/cli/test/benchmark-export.test.ts` on 22.16.0: 1 failed / 26 passed ("refuses unsafe
stored paths and collisions..."); on 24.21.0: 27 passed.

### Upstream

Node's `node_sqlite.cc` built the string with `String::NewFromUtf8(isolate, v)` (no length, so
it stops at NUL). nodejs/node#61954 ("sqlite: use OneByte for ASCII text and internalize col
names", merged to main 2026-04-11, commit ef8f8f8) passes `sqlite3_column_bytes` as the length.
It shipped in Node 24.16.0 (2026-05-21) and Node 26; it is not in any Node 22 release up to
22.23.5. It is a performance change, not labelled as a fix, so a backport to 22.x (maintenance
LTS until 2027-04-30) is unlikely without a request.

`node:sqlite` on Node 22 has no option to read TEXT as bytes (`setReadBigInts`,
`setReturnArrays`, `setAllowBareNamedParameters` and `columns()` only), so the proxy cannot
fix reads generically; `cast(x as blob)` works but only per column in each query.

### Affected inputs (audit)

- Plain TEXT columns fed from untrusted repository content: `artifacts.name` and
  `artifacts.description` come from YAML frontmatter, and YAML double-quoted `"\0"` yields NUL
  even though the file passes `isBinary` (the bytes contain no NUL). Reproduced above.
- Not affected: artifact file contents (`artifact_versions.files`, JSON) and agent output file
  contents (`agent_run_files.content`, rejected as `binary` when they contain NUL); file system
  paths (cannot contain NUL; `repository-path`, `paths.ts` and `definition.ts` reject it).
- Possible: other plain TEXT columns written from strings that may embed untrusted text
  (error and message columns, user-entered names, notes and descriptions from the web app).
  Not exhaustively traced yet; phase B would do that with the chosen approach.

### Implementation (phase B)

- `packages/database/src/client.ts`: `NulInTextError` and `refuseNulText` before `prepare`.
- `packages/database/src/stored-message.ts`: `storedMessage`, used by `insertAgentRun`
  (`error`, `outputFilesReason`, assertion `message`), `finishBenchmarkRun`, `finishJob`,
  `interruptJobs` and `markRepositoryScanFailed`.
- `packages/core/src/artifacts.ts`: `frontmatterText` for `name`/`description`, `firstHeading`
  ignores a heading with NUL; no duplicate "has no name/description" warning.
- `packages/database/src/repositories/artifacts.ts`: `isLinkable` matches the parser.
- Tests: `packages/database/test/nul-text.test.ts` (new), cases in `identity.test.ts`,
  `core/test/artifacts.test.ts`, `runner/test/repository-scan.test.ts`; the CLI export test
  stores `ctl\u0001.txt` instead of `nul\0.txt` (NUL can no longer be stored) and keeps NUL in
  the `isSafeRelativePath` unit list.
- Specs: SPEC-006 §1 (new "Text" convention) and status, SPEC-004 §3.1, SPEC-102 §14 and status.

## Verification

- Red first (source changes stashed, tests kept), Node 22.16.0: database `nul-text` 5 failed
  (`promise resolved "{ rows: [] }" instead of rejecting`, `storedMessage is not a function`),
  `identity` 1 failed (`createdArtifacts: 6` vs 7), core 2 failed, runner scan test 1 failed.
- Green on Node 22.16.0 and 24.21.0 for every new or changed test file.
- `pnpm --filter "./packages/*" --filter directivebench test` on Node 22.16.0: all packages and
  `apps/cli` pass with the 100% coverage threshold (core 353, agent-adapters 374 + 2 skipped,
  database 383, benchmark-engine 518, runner 312 + new, cli 208).
- Node 24.21.0: `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test` 0 (web 608, core 353,
  agent-adapters 374, cli 208, benchmark-engine 518, runner 313, database 383; 100% coverage),
  `pnpm format:check` clean, `pnpm build` 0, `pnpm verify:pack` passed.
- Not verified: the web app with NUL input (its Zod schemas are a follow-up; a write with NUL
  now fails with `NulInTextError` instead of truncating); `apps/cli` in the `oldest-node` CI job
  (needs PR #267); Windows and macOS.

## Problems and deviations

- Drizzle's `sqlite-proxy` wraps a callback error in its own query error whose message lists the
  parameters, so the refused value appears in that wrapper's message (as for any failing query
  before this change); `NulInTextError` itself, the `cause`, never contains the value.

## Lessons recorded

- [2026-11-19-node-22-sqlite-truncates-text-at-nul.md](../lessons/2026-11-19-node-22-sqlite-truncates-text-at-nul.md)

## Follow-ups

- Add `apps/cli` to the `oldest-node` CI job once PR #267 is merged.
- Web Zod schemas reject U+0000 in user input (after the #123 PR merges), and benchmark
  definition strings (suite `name`/`description`) get a validation message instead of
  `NulInTextError`: follow-up issue.
