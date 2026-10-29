---
title: SPEC-123 Phase 2, CLI export of agent run output files
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, Phases 2 and 3 approved on 2026-10-29), om-auto-implement-spec
status: in-progress
branch: feat/agent-run-output-files-export
specs: [SPEC-123, SPEC-014, SPEC-118]
---

# Run: SPEC-123 Phase 2, CLI export of agent run output files

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** §21 "Phase 2: CLI export" of SPEC-123 (issue #152):
`directivebench benchmark export <run-id> --out <dir> [--json]` (§6.4, FR-123-40 to FR-123-43,
AC-6). Phase 1 (capture and storage) is merged in #157. No web UI (Phase 3 runs in parallel in
another worktree), no compare, no blind review, no syntax highlighting.

Acceptance criteria used: FR-123-40 to FR-123-43, the §13 export rows, the §15 `apps/cli` unit
tests (layout, manifest, unsafe paths, non-empty target, read-only database refusal, the claim
race of FR-123-41) and AC-6.

## Plan

Goal: a user exports a run's kept, redacted files and a manifest into a fresh directory, without
any stored (untrusted) path reaching the file system unvalidated and without ever overwriting or
following anything.

Non-goals: `apps/web`, blind review (`0004` does not exist yet, so FR-123-52a's export warning
has nothing to check; it is a Phase 5 follow-up), `--blind` export (§19), changes to the
repository layer beyond reading through `getBenchmarkRunDetail`, `listAgentRunFiles` and
`getAgentRunFile`.

Risks: a hostile stored path escaping `<dir>` (mitigated by segment validation plus
`resolveInside`, exclusive create, and directories created one segment at a time inside the
claimed `files/`); a race with a concurrent writer into `<dir>` (claim with `wx` and a
non-recursive `mkdir`); case-insensitive collisions (EEXIST becomes `path-collision`).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Export command

- [x] 1.1 `benchmark export` command: target claim, path validation, file writes, manifest, summary and `--json` — 66c26d6
- [x] 1.2 Unit tests to 100%: layout, manifest, unsafe paths, collisions, refusals, claim race, runtime error — 66c26d6

### Phase 2: Verification and docs

- [x] 2.1 Full gate and a real export of a `directivebench demo` run with the built CLI
- [ ] 2.2 SPEC-123 §20 status for verified behaviour, run log, lessons

## Decisions

- **Manifest field for the export reason.** FR-123-42 says an unsafe or colliding path is "listed
  with reason `unsafe-path`"; the capture already has a `reason` (`file-limit`, `binary`, …), so
  the export reason is a separate field `exportReason` and a written file has `exportedTo`. A
  truncated file with an unsafe path keeps both. Recorded as a clarification in FR-123-42.
- **Directory collisions.** Everything below the claimed `files/` is the export's own, so an
  `EEXIST` on a directory segment the export has not created yet is a name collision (a file and
  a directory of the same name, or case/Unicode-equal names), listed as `path-collision` rather
  than merged into. Files are processed in the repository's path order, so which of two colliding
  names is written is deterministic.
- **Symbolic link as `<dir>`.** Refused with exit 2 (`lstat`, never followed), with its own
  message.
- **Order of checks.** Database and run id first, then the target, so an unknown run id or a
  missing database leaves the file system untouched.
- **A claim that loses the `files/` race removes its own `manifest.json`** (created exclusively by
  this call), so "nothing written" holds; a runtime error after the claim leaves everything in
  place and names the directory and the last file written (FR-123-43).
- **A kept row without content** (corrupt database) fails closed as a runtime error rather than
  writing an empty file.
- **Terminal output quotes untrusted text** (`JSON.stringify` of case ids and paths in the
  "Not written" lines), so control characters in an agent-written name cannot act on the
  terminal.
- **Blind review warning (FR-123-52a)** is not implemented: no blind review exists before Phase 5
  (migration `0004`); the spec's Phase 5 plan now names it.
- **`verify:pack`** gained an export of the demo run from the installed tarball, because the
  command reads the bundled migrations and the database package in the packaged CLI.

## Work performed

1. Execution plan (this file) and draft PR #161.
2. `apps/cli/src/benchmark-export.ts`, `main.ts` registration, tests
   (`apps/cli/test/benchmark-export.test.ts`, `main.test.ts`), `verify:pack` step, README CLI
   line: 66c26d6.
3. SPEC-123 FR-123-42 clarification, §20 status, Phase 5 plan note, this run log.

## Verification

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | pass (7/7 tasks) |
| `pnpm test` | pass, 100% coverage everywhere; `directivebench` 150 tests (17 new export tests) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass, including "export wrote 6 file(s)" and "manifest.json lists files that exist" |

Red first: with the NUL/backslash checks removed from `isSafeRelativePath` and `wx` replaced by
`w` (file and manifest), 4 export tests fail (path validation, hostile run, collision, the
`manifest.json` race); restored afterwards.

Real app (built `apps/cli/dist/cli.js`, temporary data directory): `demo` (exit 0), then
`benchmark export <run> --out <new dir>` wrote six `files/implement-parse-age/<variant>-<n>/src/parse-age.js`
files whose sha256 equals the manifest's (all `kept: full`), summary labelled
"Mock agent: not an AI evaluation". `--json` printed one object on stdout. Refusals, each exit 2
and nothing written: non-empty directory, a file, a symbolic link to an empty directory (target
stayed empty), a missing parent (not created), an unknown run id, a missing database (names
`directivebench init`), a missing `--out` (usage). Hostile rows planted in the demo database
(`../../escape.txt`, `/etc/abs.txt`, `a\b.txt`, `C:drive.txt`, a file `src` before
`src/parse-age.js`, `src/parse-age.js/inner.txt`, a name with an ESC byte): exit 0, four listed as
`unsafe-path`, two as `path-collision`, no file outside the export directory.

Not verified: Windows and macOS (Linux only; the junction-based symlink test and path handling
are written to be portable); a real case-insensitive file system (simulated with an `EEXIST`
hook); a real Claude Code run (not needed: export reads stored rows only).

## Problems and deviations

- FR-123-52a's export warning is deferred to Phase 5 (no blind review exists yet).

## Lessons recorded

None so far.

## Follow-ups

- Phase 5: print the FR-123-52a warning from `benchmark export` while a review is unrevealed.
