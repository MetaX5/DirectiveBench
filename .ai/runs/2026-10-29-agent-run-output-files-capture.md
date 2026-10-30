---
title: SPEC-123 Phase 1, capture and storage of agent run output files
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, Phase 1 approved on 2026-10-29), om-auto-implement-spec
status: completed
branch: feat/agent-run-output-files-capture
specs: [SPEC-123, SPEC-006, SPEC-014, SPEC-118]
---

# Run: SPEC-123 Phase 1, capture and storage of agent run output files

Source doc: .ai/specs/implemented/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** §21 "Phase 1: Capture and storage" of SPEC-123 (issue #152): the engine keeps
the files each agent run added or modified, bounded, redacted, and the runner stores them in the
local database with the agent run. No UI, no CLI export, no blind review, no syntax highlighting
(Phases 2 to 5 and 3a).

Acceptance criteria used (Phase 1 slice): FR-123-01 to FR-123-11, FR-123-60, §8.1 (migration
`0003` only), §8.2, §8.3 (`insertAgentRun`, `listAgentRunFiles`, `getAgentRunFile`), the Phase 1
tests of §15, and the engine/database side of AC-2, AC-3, AC-4, AC-8 (agent-run files only),
AC-9, AC-10 and AC-11. The UI side of AC-1 to AC-4 and AC-11 is Phase 3.

## Plan

Goal: every agent run that reached the agent stage keeps its changed files' content within the
named limits, redacted fail-closed, in `agent_run_files`, inserted in the same transaction as
the agent run.

Non-goals: pages, components, export command, blind-review tables (`0004`), Shiki, changes to
scoring, verdicts or trace redaction.

Risks: redaction gaps at the cut (mitigated by the stateful whole-file key-marker scan and the
regression tests of FR-123-07); memory retention across runs (FR-123-10, tested with a `WeakRef`
and `gc`); breaking existing `toEqual` assertions on records (handled per test).

### Phase 1: Storage

1. Migration `0003_agent_run_output_files.sql`, Drizzle schema, migration up/down test pinned to
   its journal prefix, cascade test.
2. Repository: `insertAgentRun` with files and the kept flag and reason in one transaction;
   `listAgentRunFiles`, `getAgentRunFile`.

### Phase 2: Redaction contract

1. Core `findSecretRanges(text, knownSecrets, { textEnd })`, `TextRange`, pattern minimum
   lengths; tests for every rule with both `textEnd` values.
2. `AgentAdapter.findOutputSecrets` in the contract, the mock agent and the Claude Code adapter;
   corpus test of FR-123-60.

### Phase 3: Engine capture

1. `benchmark-engine/src/output-files.ts`: bounded read through the pinned workspace with size
   and sha256 check, whole-file stateful key-marker scan, range union, cut, limits, order,
   UTF-8/NUL check, artifact-path exclusion, failure path; unit tests incl. the private-key
   regressions.
2. Wire into `executeAgentRun` (before the overlay; `completed` reuses the measurement manifest,
   `agent-error`/`timeout` build their own inside the capture's error handling), keep it on every
   later return path, deliver with `onAgentRun(record, capture)`, release it afterwards;
   status-path and memory tests.

### Phase 4: Runner and verification

1. Runner `persistAgentRun` stores the capture; runner tests.
2. SPEC-006 table list, SPEC-123 §20 status, full quality gate, real run with the built CLI
   (`directivebench demo`) checking `agent_run_files` rows and unchanged scores (AC-9).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #157

### Phase 1: Storage

- [x] 1.1 Migration 0003, schema, migration and cascade tests — be57af5
- [x] 1.2 Repository functions for agent run files — be57af5

### Phase 2: Redaction contract

- [x] 2.1 Core findSecretRanges — 0731941
- [x] 2.2 Adapter findOutputSecrets for mock and Claude Code — 47b179c

### Phase 3: Engine capture

- [x] 3.1 captureOutputFiles with bounded read, scan, cut and limits — faba0fc
- [x] 3.2 Wire capture into the orchestrator and onAgentRun — 70f4451

### Phase 4: Runner and verification

- [x] 4.1 Runner persists the capture — 41ed639
- [x] 4.2 Specs, quality gate and real-app verification — c31a635, 3f6bb7b

## Decisions

- **Key-marker scan semantics (FR-123-07).** The whole-file scan follows the core regex
  `-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----`: a start whose `[A-Z ]` run ends without
  `PRIVATE KEY-----` is no marker, exactly as for trace redaction. Only a start still undecided
  after `KEY_MARKER_MAX_BYTES` (256) bytes, or at the end of the file, counts as an `END` marker.
  A literal reading ("any start not followed by `PRIVATE KEY-----` within 256 bytes is an END")
  would turn every `-----BEGIN PUBLIC KEY-----` or `-----BEGIN CERTIFICATE-----` into an END
  marker and redact all text before it; the regex cannot match those, so they are not key
  material. Codex round 3's overlong case (a start inside the window, an 8 KiB `[A-Z]` run) is
  undecided at 256 bytes and is an END, as specified.
- **Fragments from the scan, not only the orphan END.** The scan returns the private-key
  fragments of the window by the trace-redaction rule applied to its markers (up to the first
  marker ending after the window). This covers the orphan END beyond the window (round 2), an END
  straddling the window end, and an overlong END that the scan ends *inside* the window (round 3),
  which the window regex alone cannot see. The engine unions these with the core and adapter
  ranges (fail closed).
- **Reason texts.** `outputFiles.reason` is a short lower-case clause to follow "Output files were
  not kept:" (e.g. `the agent did not stop after its timeout`, `the workspace was replaced during
  the agent run`, `the agent run ended before its output files were captured`, or the redacted
  capture error such as `a.txt changed after the agent stopped`). The standalone engine uses the
  code `no-consumer` as FR-123-10 names it.
- **Index.** `agent_run_files` has the unique index `(agent_run_id, path)` only; it leads with
  `agent_run_id`, so the separate `agent_run_id` index of §8.1 would be redundant.
- **Claude Code known secrets** include the JSON-escaped forms of the API key, as the stream
  parser does (`withJsonForms`, now exported).
- **Fake `claude` writes `key.txt` in API Key Mode** so the CLI test proves end to end that a key
  the agent writes into a file is stored only redacted (AC-3).

## Work performed

1. `be57af5` migration `0003_agent_run_output_files`, schema, `insertAgentRun` with files,
   `listAgentRunFiles`, `getAgentRunFile`; migration up/rollback test pinned to journal prefix 3;
   cascade, scoping and atomicity tests.
2. `0731941` core `findSecretRanges`, `mergeTextRanges`, `replaceTextRanges`, `TextRange`,
   `TextEnd`, exported `SECRET_PATTERNS` with `SECRET_PATTERN_MIN_LENGTHS` (checked per pattern).
3. `47b179c` `AgentAdapter.findOutputSecrets`; mock (core rules) and Claude Code (API key and its
   JSON forms in API Key Mode); corpus test of FR-123-60.
4. `faba0fc` `benchmark-engine/src/output-files.ts`: `captureOutputFiles`, `KeyMarkerScan`,
   `placeCut`, `trimIncompleteUtf8`, `utf16Ranges`, limits and constants; unit and
   simulated-file-system tests.
5. `70f4451` orchestrator wiring (`onAgentRun(record, capture)`, `outputFiles` summary, capture
   before the overlay, kept on later return paths, status-path and memory tests).
6. `41ed639` runner persists the capture; vertical-slice test checks the stored files.
7. `c31a635` CLI fake-`claude` test: `output.md` kept for the candidate, a key written by the
   agent stored as `key=[REDACTED]`.
8. `3f6bb7b` SPEC-006 table list (§3.15) and status, SPEC-123 §20, lesson.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (7 tasks) |
| `pnpm test` | pass: 1,965 tests (cli 132, database 163, core 286, web 278, runner 234, agent-adapters 362 + 2 skipped, benchmark-engine 510), 100% coverage in every package |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass (`Packaging verification passed`; demo, serve, health) |
| `node apps/cli/dist/cli.js --data-dir <tmp> demo` | verdict improved, delta +50 points (as before); 6 agent runs, each `output_files_kept = 1` with one `agent_run_files` row `src/parse-age.js` (`full`, 184 or 544 bytes, 0 redactions, content equal to the written file) |

Red-first proof: with the scan's key fragments removed from the union, the 9 regression tests of
Codex rounds 2 and 3 (3 cases × mock, Claude Code, no-range adapter) fail and only the round 1
case passes (the window regex sees its BEGIN). The memory test of FR-123-10 fails when the
capture is deliberately retained on the record, and passes otherwise.

Not verified: a real `claude` session (never run, by rule); Windows (the `O_NOFOLLOW`-less path
is simulated in `output-files-simulated-fs.test.ts`); NFR-123-01 capture time (target, no
timing test); upgrading a data directory created by a released CLI (covered by the migration
test on a `0002` database only); any UI (Phase 3).

## Review

- `om-auto-review-pr` round 1 (COMMENT, the author cannot approve): approve-equivalent, one minor
  finding (a deleted file under the installed artifact listed as `deleted` instead of
  `artifact-path`, FR-123-08), fixed in `0d04450` with a test.
- Codex adversarial review:
  - Round 1, needs-attention: (1) capture checked only canonical path strings, not the pinned
    workspace's dev/ino, and could follow a link in an intermediate component; (2) the read
    after the window ran to EOF, unbounded on a growing file. Fixed in the next commit:
    `assertDirectoryInsidePin` (root dev/ino, `lstat` of every directory component, canonical
    parent) before and after the open; reads bounded to the manifest size plus a one-byte
    probe. Regression tests: wrong pin inode, an in-workspace directory link, a growing and a
    shrinking file.
  - Round 2, needs-attention (high): `buildManifest` (the agent-error/timeout capture's own
    manifest) hashed with `createReadStream` to EOF. Fixed: `sha256File` reads at most the
    walked size plus one byte and refuses growth. Regression test on the capture path.
  - Round 3, needs-attention: a failing workspace `rm` in `executeAgentRun`'s `finally` rejected
    before `onAgentRun`, discarding the record and capture. Fixed `d305e89`: the agent run
    directory is removed in `runAndDeliver` after delivery. Regression test with a
    non-writable directory.
  - Round 4 (after merging `origin/main`): no material findings; approval withheld only because
    Codex's sandbox could not run the gate.
  - Round 5 (head `8e0fb3d`, given the passing gate results of that head): **approve**, no
    material findings.

## Merge with main

`origin/main` moved during the run (#155 design-system components and
`apps/web/lib/syntax-highlight.ts`, #156 FR-123-78, the #122 fix). The merge `8e0fb3d`
conflicted only in `.ai/lessons.md` (both sides added index entries at the top): kept all
entries, this run's first. SPEC-123 §20 merged cleanly; its "Not implemented" bullet now names
FR-123-78 and points to #155's run log for the components that landed there. Full gate rerun on
the merged head: lint, format:check, typecheck, test (2,087 tests), build and verify:pack all
pass.

## Problems and deviations

- A test token `ghp_…` followed directly by `aaa…` was matched with the `a`s (the pattern is
  greedy over alphanumerics); the test now separates the token with a space.
- The literal-reading deviation on overlong markers is recorded under Decisions.

## Lessons recorded

- [Prove a memory-release test fails on a real leak](../lessons/2026-10-29-prove-a-memory-release-test-fails-on-a-leak.md)

## Follow-ups

- Phases 2 (CLI export), 3 (run page, after A14), 3a, 4 and 5 of SPEC-123.
- A timing test for NFR-123-01 if capture time becomes a concern.
