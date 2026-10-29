---
title: SPEC-123 Phase 2, CLI export of agent run output files
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, Phases 2 and 3 approved on 2026-10-29), om-auto-implement-spec
status: completed
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
- [x] 2.2 SPEC-123 §20 status for verified behaviour, run log, lessons — abd798a

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
- **Claim order `files/` then `manifest.json`** (changed after Codex round 1): a lost
  `manifest.json` claim removes the export's own empty `files/` with `rmdir`, which cannot delete
  another writer's data; a runtime error after the claim leaves everything in place and names the
  directory and the last file written (FR-123-43).
- **Replaced directories (Codex round 1):** `<dir>`'s parent is canonicalised once; created
  directories are 0700 and must be owned by the user; files 0600; before any content is written
  the chain's `dev`/`ino` and the opened handle are re-checked (`ExportTree`), so a swapped
  directory, symlink or file stops the export with exit 1 and never receives content.
- **The export directory as the working directory (Codex rounds 2 and 3):** path checks cannot
  beat a swap-and-restore race and an ancestor permission walk misses POSIX ACLs, so the export
  `chdir`s into `<dir>` after checking it, requires `lstat('.')` to be the directory checked, and
  uses only relative paths; ancestors no longer matter. `<dir>` must be owned by the user and not
  group- or other-writable (an existing 0775 directory under umask 002 is refused; the export
  creates its own 0700 one). Same-user processes are outside the threat. Residuals in the spec:
  Windows ACLs, macOS extended ACLs. `process.chdir` is restored in `finally`; Vitest's default
  `forks` pool allows it.
- **Portable names:** after self-review, `:`, `<>"|?*`, control characters, a trailing dot or
  space and Windows device names are `unsafe-path` everywhere (NTFS streams, devices, merged
  names on Windows; an ESC byte in a file name).
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
3. SPEC-123 FR-123-42 clarification, §20 status, Phase 5 plan note, this run log: abd798a.
4. Self-review: portable-name validation: 74f6b1c.
5. Codex adversarial review round 1 (needs-attention, 2 high): chain identity verification,
   claim order, private modes, canonical parent, regression tests; lesson: 37a1bc1.
6. Codex round 2 (needs-attention, 1 high): a swap-and-restore between two `lstat`s defeats the
   path checks. Fixed by refusing (exit 2) a target or ancestor another user can change (owner,
   others-write, foreign-group write, sticky exempt); Windows simulated by `process.getuid`
   returning undefined: a3f770a.
7. Codex round 3 (needs-attention, 1 high): a POSIX ACL can grant another user write behind the
   group bits of a user-owned ancestor. Replaced the ancestor walk by working inside `<dir>` as
   the working directory (`chdir`, `lstat('.')` identity against the checked directory, relative
   paths only, cwd restored in `finally`); `<dir>` must be the user's and not group- or
   other-writable (exit 2): 9b62aec.
8. Codex round 4: **approve** (no material finding within the threat model).

## Review

| Round | Reviewer | Verdict | Findings and outcome |
| --- | --- | --- | --- |
| self | `om-auto-review-pr` / `om-code-review` | changes (fixed) | Non-portable names (`:`, `<>"\|?*`, control characters, trailing dot or space, Windows devices) were accepted: fixed in 74f6b1c. |
| 1 | Codex adversarial | needs-attention | (high) a replaced directory or symlink could redirect writes; (high) undoing a lost claim unlinked `manifest.json` by path: chain verification, `files/`-first claim with `rmdir`, 0700/0600 (37a1bc1). |
| 2 | Codex adversarial | needs-attention | (high) swap-and-restore between two `lstat`s defeats path checks: ancestor permission walk (a3f770a). |
| 3 | Codex adversarial | needs-attention | (high) POSIX ACLs bypass the ancestor walk: export works inside `<dir>` as its working directory, `<dir>` owned by the user and not group- or other-writable (9b62aec). |
| 4 | Codex adversarial | approve | none |

## Verification

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | pass (7/7 tasks) |
| `pnpm test` | pass, 100% coverage everywhere; `directivebench` 159 tests (26 export tests) |
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

After Codex round 1 the built CLI was re-run: export of the demo run wrote 6 files, `<dir>`
and `files/` mode 700, files and `manifest.json` mode 600. The swap races are exercised by hooks
in the unit tests (directory replaced, directory replaced by a symbolic link, opened file
replaced, `manifest.json` replaced, a created directory not owned by the user), each exit 1 with
no content in the replacement. After round 3 the built CLI exported into `<0777 dir>/x` (created
0700) and refused an existing 0777 or 0775 `<dir>` with exit 2.

Not verified: Windows and macOS (Linux only; the junction-based symlink test and path handling
are written to be portable); a real case-insensitive file system (simulated with an `EEXIST`
hook); a real Claude Code run (not needed: export reads stored rows only).

## Problems and deviations

- FR-123-52a's export warning is deferred to Phase 5 (no blind review exists yet).

## Lessons recorded

- [Exclusive create guards only the last name of a path; undo a claim with `rmdir`](../lessons/2026-10-29-exclusive-create-guards-only-the-last-name.md)

## Follow-ups

- Phase 5: print the FR-123-52a warning from `benchmark export` while a review is unrevealed.
