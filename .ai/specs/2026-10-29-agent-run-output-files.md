---
id: SPEC-123
title: Keep and review the files an agent run wrote (output files, comparison, blind review)
status: draft
created: 2026-10-29
updated: 2026-10-29
category: feature
related: [SPEC-118, SPEC-112, SPEC-110, SPEC-113, SPEC-006, SPEC-007, SPEC-014, SPEC-122, SPEC-203]
---

# SPEC-123 — Keep and review the files an agent run wrote

## 1. Summary

A skill author who wants to judge a verdict, or debug an assertion, by reading what the agent
actually wrote cannot do that today: every agent run's workspace is deleted when the run ends,
and the trace keeps only truncated tool-call inputs (about 2,000 characters). This spec proposes
(future behaviour) that DirectiveBench **keeps the files each agent run added or changed**,
bounded (1 MB per file, 10 MB per agent run), redacted like traces, stored with the benchmark run
and removed with it, and lets a human **read them on the run page**, **compare the same file
between two agent runs side by side**, **export them to a directory from the CLI**, and **review
baseline and candidate blind** as unlabelled A/B pairs, recording a verdict before the variants
are revealed.

Source: issue #152 (backlog E08) and the maintainer's decisions of 2026-10-29 on that issue
(limits, retention, blind review in scope, access paths). Those decisions are binding inputs here,
not autonomous defaults.

## 2. Motivation and problem statement

- In the first real D03 check ([run log](../runs/2026-10-29-d03-check-wp-block-development.md))
  the maintainer's planned blind comparison of outputs, the human side of
  [D03](research/decisions/D03-success-means-verdicts-hold-in-real-projects.md), could not be
  done: "Agent workspaces are deleted after the run, and tool-call inputs in the trace are
  truncated (about 2,000 characters), so the files the agent wrote cannot be rebuilt." An attempt
  to rebuild them from traces failed on truncated JSON.
- False assertion failures could only be spotted from trace fragments
  ([lesson](../lessons/2026-10-29-assert-outcomes-not-one-solution.md)): 6 of 12 runs failed a
  `deprecation-registered` check, and only 2 could be checked by hand.
- [D09](research/decisions/D09-suite-must-discriminate-before-version-verdicts.md) records that
  "a human comparison also needs the agent's output files, which DirectiveBench does not keep
  yet".
- Code today: `runAgent` in `packages/benchmark-engine/src/orchestrator.ts` computes
  `changedFiles` (paths and change kind only) and removes the run directory in `finally` unless
  `runner.keepWorkspaces` is set. `keepWorkspaces` keeps whole workspaces unbounded,
  unredacted and outside the database, and nothing shows them; it is a debugging switch, not a
  review feature.

Prior art (from general knowledge of these tools, not re-checked for this spec): evaluation
tools such as Promptfoo's result viewer keep each test's output in their result store and show
outputs side by side, and annotation tools such as LangSmith offer pairwise human review. That
supports keeping output in the result store (A2) and pairwise review (§6.5). What this spec skips:
rating scales, reviewer queues and multi-reviewer agreement, which a single local maintainer does
not need yet.

The capability is generic: any suite whose agent writes files (code, Markdown documents,
configuration) benefits. The WordPress block suite of the D03 check and a Markdown estimation
document are reference scenarios used to check the design, not targets.

## 3. Goals

- G1: Every agent run that reached the agent stage keeps the content of the files it added or
  modified, within named limits, redacted, in the local database, bound to the agent run.
- G2: A truncated or omitted file always says so, with the reason, everywhere it is shown or
  exported.
- G3: The run page shows the kept files per case, variant and repetition, read-only.
- G4: The same file can be compared side by side between two agent runs of one benchmark run.
- G5: `directivebench benchmark export` writes the kept files of a benchmark run to a directory
  with a manifest.
- G6: A human can review baseline and candidate outputs blind as A/B pairs; each verdict is
  recorded before the variants are revealed and cannot be changed afterwards.
- G7: Deleting a benchmark run (when such an action exists) removes its files and its blind
  review by database cascade, with no separate cleanup.

## 4. Non-goals

- Keeping whole workspaces, fixture copies, the installed artifact or files the agent did not
  change (`runner.keepWorkspaces` stays the debugging switch it is).
- Running, building or rendering the output (no preview server, no HTML or Markdown rendering of
  output in this spec; raw text only).
- Changing trace truncation, scoring, verdicts or display status. Blind-review verdicts are stored
  next to the run and never change its score or verdict.
- Deciding how human verdicts aggregate into a D03 observation (D03/Q05 stays open).
- Cloud storage, sharing, multi-user reviewer identity.
- A run-deletion feature (none exists today; §8.1 makes deletion cascade when it is built).
- Binary file content (§6.1 FR-123-05).

## 5. User stories

- As a skill author, after a benchmark run I open the run page, pick case `extend-existing-block`,
  candidate repetition 2, and read `src/block.json` and `render.php` in full, so I can see why
  `deprecation-registered` failed.
- As a skill author, I compare `render.php` of baseline repetition 1 with candidate repetition 1
  side by side, so I can see what the skill changed in the output.
- As the maintainer running a D03 check, I start a blind review of a run, judge each pair as
  "A is better", "B is better" or "About the same" without knowing which side had the skill, and
  only then reveal which was which, so my judgement is not biased by the label.
- As a skill author, I export a run's files to a folder and open them in my editor or diff tool.

## 5a. Resolved assumptions (autonomous defaults)

Written by `om-auto-write-spec` without a human in the loop. The maintainer decisions of
2026-10-29 (limits, retention, blind review in scope, access paths) are not listed here; they are
inputs. Every row below is a default to confirm or override before implementation.

| # | Question | Applied default | Why | Confirm? |
| --- | --- | --- | --- | --- |
| A1 | One spec or split (storage, viewer, export, diff, blind review)? | One spec, five phases, one PR each. Dependencies: 2 needs 1; 3 needs 1; 4 needs 3; 5 needs 4. Blind review could move to its own spec (own data model and integrity rules); kept here because the maintainer placed it in E08. | Phases keep PRs small; each phase leaves the app working. | reversible |
| A2 | Where are files stored? | In SQLite, new table `agent_run_files` with `ON DELETE CASCADE` from `agent_runs`. | Retention "removed with the run" follows from the existing cascade; persistence stays in repositories (SPEC-014 §3.2); the web app reads without file-system access. Cost: up to 10 MB per agent run in the database. | reversible before release |
| A3 | Unit of "1 MB" and "10 MB"? | Bytes of UTF-8 text: `OUTPUT_FILE_MAX_BYTES = 1_048_576`, `OUTPUT_RUN_MAX_BYTES = 10_485_760` (MiB, as the rest of the codebase). UI copy says "1 MB" / "10 MB". | Matches existing limits (`2 MiB` per assertion read). | reversible |
| A4 | Which files take the run budget first? | Ascending original size, then path. | Many small source files are kept whole; a large generated file or dependency folder cannot starve them. Generic, deterministic. | reversible |
| A5 | Binary files? | Metadata only (size, sha256, "binary, not kept"); content is kept only when it is valid UTF-8 without NUL. | Redaction cannot be guaranteed for binary data (fail closed, SPEC-014 §4); lesson "store only content that passes `isUtf8`". | reversible |
| A6 | Which agent runs keep files? | Execution status `completed`, `agent-error` and `timeout`, when the workspace pin still holds. Not `cancelled` or `infrastructure-error` (before the agent stage, or a replaced workspace). | Partial output of a failed run is the most useful debugging evidence; a replaced workspace is untrusted. | reversible |
| A7 | Files under the installed artifact's paths? | Not kept; listed as "artifact file, not kept". | They are the artifact, not output, and in a `none` baseline their presence would reveal the variant in blind review. | reversible |
| A8 | Blind review unit and eligibility? | A pair is the baseline and candidate agent run of one case and repetition, both `completed` with files kept. Other pairs are listed as excluded with a count. | Pairs match SPEC-112's interleaved design; failures would reveal more than the files. | reversible |
| A9 | When is a blind review revealed? | Once per review, for all pairs at once, by an explicit "Reveal variants" action with inline confirmation. Verdicts are immutable once recorded; after the reveal no verdict can be recorded. | Revealing pair by pair would teach the reviewer each side's style and bias the remaining pairs. | reversible |
| A10 | How many blind reviews per benchmark run? | One (unique per run). Restarting or deleting a review is a follow-up. | A second review after a reveal would not be blind. | reversible |
| A11 | Verdict values? | `a`, `b`, `tie` ("A is better", "B is better", "About the same") plus an optional note (at most 2,000 characters). | Smallest set that answers "which output is better"; a note keeps the reason. | reversible |
| A12 | Diff implementation? | Hand-written line diff (Myers) in `apps/web/lib`, bounded by `FILE_DIFF_MAX_EDIT_LINES = 1000`; above it, the two files are shown side by side without alignment and the page says so. No new dependency. | SPEC-004 dependency policy; bounded cost on 1 MB inputs (lessons on superlinear work). | reversible |
| A13 | CLI command name? | `directivebench benchmark export <run-id> --out <dir> [--json]`. | Lives with `benchmark init` and `benchmark run`; "export" is the verb users expect. | reversible |
| A14 | New UI components (file list with status, side-by-side file view/diff, verdict form)? | Proposed as new design-system components with stories (SPEC-122 "Contributing"): `FileStatusBadge` (a Badge variant use), `FileView` (line-numbered `Pre`) and `SideBySideDiff`. The verdict uses existing `Button`s, no radio primitive. | `apps/web/design-system.md` says a new component or variant needs the maintainer's approval; this default cannot grant it. | ⚠ NEEDS HUMAN CONFIRMATION |

## 6. Functional requirements

### 6.1 Capture (engine and runner)

| ID | Requirement |
| --- | --- |
| FR-123-01 | After the agent stage and **before** the verification overlay is applied, the engine SHALL build the workspace manifest and the change list (`diffManifests`) for every agent run whose status is `completed`, `agent-error` or `timeout`, **whose adapter returned (its process tree has exited)** and whose workspace pin was checked and still holds (the `replacedAfter('the agent run')` check ran and passed). Excluded: the engine's own timeout fallback ("Agent did not stop after timeout"), where the agent may still be writing; and runs ending with a code in `STOP_CODES`, for which that check is skipped today. It SHALL capture the files of that change list (FR-123-02…08) and return them with the agent-run record. Cancelled and infrastructure-error runs keep no files (A6). Capturing after the overlay would mix verification files into the output. |
| FR-123-02 | For each `added` or `modified` path, the engine SHALL open the file through the pinned workspace without following a symlink in any path component (`O_NOFOLLOW` on each component, or a walk relative to directory handles, with the identity check of the lesson on `O_NOFOLLOW`), `fstat` the opened handle and compare its size and modification time with the manifest entry; a full read also compares the sha256 of the bytes read. A mismatch fails the capture (FR-123-09). It SHALL keep: path, change kind, original size, sha256 of the original bytes (from the manifest, not from the caller), and, when kept, the content. A `deleted` path is recorded with metadata only. |
| FR-123-03 | **Limits.** Content is kept within `OUTPUT_FILE_MAX_BYTES` (1 MiB) per file and `OUTPUT_RUN_MAX_BYTES` (10 MiB) per agent run, counted as **original bytes kept** (redaction then changes the stored length by at most a few bytes per match; `stored_bytes` records the result). Files are processed in ascending original size, then path (A4). A file over the per-file limit is cut at the last whole UTF-8 character within the limit and marked `truncated` with reason `file-limit`; a file cut by the remaining run budget is marked `truncated`, reason `run-limit`; a file for which no budget is left keeps no content, `not-kept`, reason `run-limit`. |
| FR-123-04 | **Bounded read and a safe cut.** The engine SHALL read at most `cut + OUTPUT_REDACTION_MARGIN_BYTES` bytes of a file (margin 4 KiB), never the whole of a larger file, where `cut` is the number of original bytes it may keep. The cut is placed on the **original** bytes, never on redacted text: the kept prefix is original bytes `[0, cut)`, redacted; any redaction match found in the read window (known secret or pattern) that starts before `cut` and ends at or after it moves the cut to that match's start, and the stored text ends with the redaction marker. A match cut short by the end of the read window cannot reach into the kept prefix, because the prefix ends at least `OUTPUT_REDACTION_MARGIN_BYTES` before the window ends and no known secret or pattern match is longer than the margin (named limit; a longer known secret is refused at readiness, as the 8-character minimum is today). Tests: a secret straddling the cut, earlier redactions that shorten the text, and a cut-short secret at the end of the window. |
| FR-123-05 | **Text only.** Content is kept only when the bytes read are valid UTF-8 (`isUtf8`, after trimming an incomplete final character of a cut read) and contain no NUL byte; otherwise the file is `not-kept`, reason `binary`. |
| FR-123-06 | **Artifact files.** Paths equal to or under the `installedPaths` of the agent run are `not-kept`, reason `artifact-path` (A7). |
| FR-123-07 | **Redaction.** Kept text SHALL be redacted before it is cut and before it leaves the engine, with the same redaction the adapter applies to its trace, including the secrets only the adapter knows (the API key in API Key Mode). The number of redactions in the kept text is recorded per file. |
| FR-123-08 | **Persistence.** The runner SHALL insert the captured files in the same transaction that inserts the agent run (`insertAgentRun`), and set `agent_runs.output_files_kept = 1` for an agent run whose capture ran (also when it changed no file), so "no files changed" differs from "files not kept" (runs stored before this spec, cancelled runs). |
| FR-123-09 | A failure while capturing (unreadable file, `UnsafeFileError`, a limit of the manifest, a file that changed after the manifest) SHALL NOT change the agent run's status, score or assertions: the capture records `output_files_kept = 0` and the warning `output-files-not-kept` with the reason (redacted), and the run continues. The output files are evidence for humans, not part of the measurement. |

### 6.2 Run page (web, read-only)

| ID | Requirement |
| --- | --- |
| FR-123-20 | The run detail page (`/results/[id]`) SHALL show an "Output files" section: per case, a table of its agent runs (variant, repetition, execution status, number of changed files, kept size, number of truncated or not-kept files) with a link "View files" per agent run. A run whose agent runs predate this spec says "Output files were not kept for this run." |
| FR-123-21 | `/results/[id]/agent-runs/[agentRunId]` SHALL list the agent run's changed files (path, change, size, status) and show the selected file (`?path=`) as escaped, line-numbered text. A truncated file shows "Truncated at 1 MB: the file has N bytes" (or "Truncated: the 10 MB limit for this agent run was reached"); a not-kept file shows why ("Binary file, not kept", "Deleted by the agent", "Artifact file, not kept", "Not kept: the 10 MB limit for this agent run was reached"); a file with redactions shows "N secrets redacted". Mock runs keep `MockBadge`. The agent run must belong to the benchmark run in the URL (else not found). |
| FR-123-22 | File content SHALL be loaded one file per request by a repository function; `getBenchmarkRunDetail` SHALL NOT load file content. |

### 6.3 Side-by-side comparison (web)

| ID | Requirement |
| --- | --- |
| FR-123-30 | `/results/[id]/compare?case=<caseId>&left=<agentRunId>&right=<agentRunId>&path=<path>` SHALL list the union of changed paths of the two agent runs (marking paths present on one side only) and show the selected path side by side with a line diff. Both agent runs must belong to the benchmark run and to the same case. Defaults: left = baseline repetition 1, right = candidate repetition 1, path = first path in the union. |
| FR-123-31 | The diff SHALL be line-based and bounded (A12): `FILE_DIFF_MAX_EDIT_LINES` (1000) changed lines; above it the page shows both files side by side without alignment and says "These files differ in more than 1,000 lines, so they are shown without alignment." Truncation and not-kept status of either side are shown above the diff as in FR-123-21. |
| FR-123-32 | Added and removed lines SHALL be identified by a text marker and an accessible name, not only by colour. |

### 6.4 CLI export

| ID | Requirement |
| --- | --- |
| FR-123-40 | `directivebench benchmark export <run-id> --out <dir> [--json]` SHALL write every kept file of the benchmark run to `<dir>/files/<caseId>/<variant>-<repetition>/<path>` (under `files/`, so no case id can collide with the manifest) and a `<dir>/manifest.json` with the run id, suite name and version, candidate and baseline labels, and per agent run its execution status and every changed file (path, change, size, sha256 of the original, `kept: full \| truncated \| none`, reason, redactions). It prints a summary (files written, truncated, not kept); `--json` prints the manifest summary as one JSON object. |
| FR-123-41 | `<dir>` SHALL not exist or be an empty directory (else exit 2, nothing written). The command opens the database read-only (as `benchmark run`'s refusals, lesson 2026-10-22) and refuses a missing or unmigrated database with exit 2, naming `directivebench init`. An unknown run id exits 2 with the message "No benchmark run <id>". |
| FR-123-42 | **Paths are untrusted.** Every stored path and case id SHALL be validated before it reaches the file system: relative POSIX, segments not empty, `.` or `..`, no NUL, no backslash, no drive or UNC prefix, resolved with `resolveInside(<dir>)`. Files are created with exclusive create (`wx`), so nothing existing is overwritten or followed. A path that fails validation is not written and is listed in the manifest with reason `unsafe-path`; a path whose exclusive create fails with `EEXIST` (names that differ only in case or Unicode normalisation on a case-insensitive file system) is listed with reason `path-collision`. Both keep exit code 0 and are named in the summary. |
| FR-123-43 | Exit codes: 0 written (also with truncated, not-kept, `unsafe-path` or `path-collision` entries, which the summary names), 2 usage or refusal, 1 runtime error (a partially written directory is reported with its path, never deleted silently). |

### 6.5 Blind review (web)

| ID | Requirement |
| --- | --- |
| FR-123-50 | The run page SHALL offer "Start blind review" for a completed benchmark run with at least one eligible pair (A8); otherwise it says why it is unavailable ("No pair of completed agent runs with kept files"). Starting is a server action; the repository runs one `withTransaction` whose first statement is `INSERT INTO blind_reviews … ON CONFLICT(benchmark_run_id) DO NOTHING RETURNING id`; when nothing is returned it selects and returns the existing review, otherwise it inserts the pairs in the same transaction. Two concurrent starts yield one review (tested with two parallel calls; idempotent, unique per run, A10). Inside the transaction it asserts that both agent runs of every pair belong to the run and the case and differ. |
| FR-123-51 | At creation, for each eligible pair the repository SHALL assign the baseline and candidate agent runs to sides A and B with `crypto.randomInt`, and shuffle the pair order. The assignment is stored; it is never derived from ids, order or time. |
| FR-123-52 | **Nothing reveals the variant before the reveal.** For an unrevealed review, `/results/[id]/blind-review?pair=<position>&path=<path>` (its own route, keyed only by pair position and path; it never takes or emits agent-run ids) SHALL show only: the case prompt, the pair's position ("Pair 3 of 6"), and the files of side A and side B side by side with the diff of FR-123-31, labelled "A" and "B". It SHALL NOT show or send to the browser the variant, the agent-run id, repetition, execution status, score, assertion results, duration, tokens, trace, warnings, the baseline label, or artifact-path entries. The repository function that serves an unrevealed pair returns only those fields, so a page cannot leak what it never receives. |
| FR-123-52a | **Labelled views are closed during a blind review.** While a run has an unrevealed review, the run page's "Output files" card, the agent-run files page and the compare page SHALL NOT show labelled outputs, file counts or sizes; they show "A blind review of this run is in progress. Labelled output files are hidden until you reveal it." with a link to the review. The CLI export is not blocked (the user runs it deliberately) but prints a warning that a blind review of the run is in progress. Residual, stated on the review page: scores and assertion results on the run page stay visible, and content written by the agent may still hint at the variant; a reviewer who wants the strictest blindness starts the review before reading the run's results. |
| FR-123-53 | **Verdict.** Per pair the reviewer chooses "A is better", "B is better" or "About the same", with an optional note (at most 2,000 characters). The server action validates with Zod and records it with one conditional statement: it succeeds only while the pair has no verdict and its review is not revealed. A recorded verdict cannot be changed; the page shows it as recorded. |
| FR-123-54 | **Reveal.** "Reveal variants" (inline confirmation: "Revealing ends the blind review. Pairs without a verdict stay without one.") sets `revealed_at` with one conditional statement. After the reveal the page shows per pair which side was baseline and candidate, the verdict, and a summary: "Candidate preferred in X of N pairs, baseline in Y, about the same in Z, no verdict in W." The summary is also shown on the run page next to (not inside) the verdict, labelled "Human blind review", and never changes score, verdict or display status. |
| FR-123-55 | A mock-agent run can be blind-reviewed (to exercise the flow), and its review keeps `MockBadge` and the label "Mock agent: not an AI evaluation". |

### 6.6 Adapter contract

| ID | Requirement |
| --- | --- |
| FR-123-60 | `AgentAdapter` SHALL gain `redactOutput(text: string): string`, the redaction the adapter applies to its own trace texts, including secrets only it knows. The Claude Code adapter implements it with `redactStreamText(text, secrets)`; the mock agent with `redactSecrets(text)`. The engine calls it for every kept file (FR-123-07). Secrets never leave the adapter. |

## 7. Non-functional requirements

- NFR-123-01 (target, not an acceptance criterion): capture adds at most 1 s per agent run for
  10 generated text files of 1 MiB each, measured by a timing test with a generous bound on the CI
  runner (lesson 2026-10-21 on timing tests); one bounded read and one linear redaction pass per
  file.
- NFR-123-02 (target): the diff of two generated 1 MiB files with 1,000 changed lines finishes
  in under 1 s in a unit timing test with a generous bound; the hard guarantee is the edit bound
  `FILE_DIFF_MAX_EDIT_LINES`, which is tested exactly.
- NFR-123-03: Database growth is bounded by `OUTPUT_RUN_MAX_BYTES` per agent run (a 24-run
  benchmark run at most about 240 MiB of kept text). Shown in the docs of the export command.
- NFR-123-04: 100% unit coverage for new logic in `packages/*/src`, `apps/cli/src`,
  `apps/web/lib` (AGENTS.md §2.7); Playwright tests for every new page and the blind-review
  flow, driven by mock-agent runs; Storybook stories in both themes with axe for new components.
- NFR-123-05: No paid or authenticated call in tests; the capture is tested with the mock agent
  and the fake `claude` executable of SPEC-118.

## 8. Domain entities and contracts

### 8.1 Data model

Two additive migrations, one per phase that needs it: `0003_agent_run_output_files.sql` (Phase 1: `agent_runs.output_files_kept`, `agent_run_files`) and `0004_blind_reviews.sql` (Phase 5: `blind_reviews`, `blind_review_pairs`). Existing rows keep working:
`output_files_kept` defaults to 0, so old runs read as "not kept".

| Table | Column | Type | Notes |
| --- | --- | --- | --- |
| `agent_runs` | `output_files_kept` | integer (boolean) not null default 0 | FR-123-08. |
| `agent_run_files` (new) | `id` | text pk | `createId('afile')` |
| | `agent_run_id` | text not null, FK `agent_runs(id)` `ON DELETE CASCADE` | |
| | `path` | text not null | workspace-relative POSIX path as in `changed_files`; untrusted display text |
| | `change` | text not null: `added` \| `modified` \| `deleted` | |
| | `size_bytes` | integer null | original size; null for `deleted` |
| | `sha256` | text null | of the original bytes, from the manifest; null for `deleted` |
| | `kept` | text not null: `full` \| `truncated` \| `none` | |
| | `reason` | text null: `file-limit` \| `run-limit` \| `binary` \| `deleted` \| `artifact-path` | null when `full` |
| | `content` | text null | redacted UTF-8 text; null when `kept = none` |
| | `stored_bytes` | integer not null default 0 | UTF-8 bytes of `content` |
| | `redactions` | integer not null default 0 | |
| | | unique (`agent_run_id`, `path`); index `agent_run_id` | |
| `blind_reviews` (new) | `id` | text pk | `createId('brev')` |
| | `benchmark_run_id` | text not null unique, FK `benchmark_runs(id)` `ON DELETE CASCADE` | one per run (A10) |
| | `created_at` | text not null | |
| | `revealed_at` | text null | set once, by a conditional update |
| `blind_review_pairs` (new) | `id` | text pk | `createId('bpair')` |
| | `review_id` | text not null, FK `blind_reviews(id)` `ON DELETE CASCADE` | |
| | `position` | integer not null | shuffled order, unique per review |
| | `case_id` | text not null | |
| | `a_agent_run_id`, `b_agent_run_id` | text not null, FK `agent_runs(id)` `ON DELETE CASCADE`, `CHECK (a_agent_run_id <> b_agent_run_id)` | random side assignment (FR-123-51); same run and case asserted at creation (FR-123-50) |
| | `verdict` | text null: `a` \| `b` \| `tie` | immutable once set |
| | `note` | text null | at most 2,000 characters, user text, shown escaped |
| | `decided_at` | text null | |

Variant and repetition of a side are read from `agent_runs` through the foreign key; they are
not duplicated. The only read paths are repository functions; the unrevealed-pair function
selects no variant field (FR-123-52). Nothing here holds a secret: content is redacted before it
reaches the runner (FR-123-07), and notes are the user's own text.

Retention: `agent_run_files` and blind reviews go with their benchmark run through the cascade
(`benchmark_runs` → `agent_runs` → `agent_run_files`, `benchmark_runs` → `blind_reviews` →
`blind_review_pairs`). `PRAGMA foreign_keys = ON` is already set by the client. No run deletion
exists today; a future one needs no extra cleanup.

```mermaid
flowchart LR
    classDef newEntity fill:#2f6feb,color:#fff,stroke:#1b4fb0
    classDef existingEntity fill:#e5e7eb,color:#111,stroke:#9ca3af

    entity_1["agent_run_files"]:::newEntity
    entity_2["blind_reviews"]:::newEntity
    entity_3["blind_review_pairs"]:::newEntity
    entity_4["agent_runs (changed: output_files_kept)"]:::newEntity
    entity_5["benchmark_runs"]:::existingEntity

    entity_4 -->|"n-1, cascade"| entity_5
    entity_1 -->|"n-1, cascade"| entity_4
    entity_2 -->|"1-1, cascade"| entity_5
    entity_3 -->|"n-1, cascade"| entity_2
    entity_3 -->|"n-1 side A"| entity_4
    entity_3 -->|"n-1 side B"| entity_4
```

### 8.2 Engine and adapter contracts

- `AgentRunRecord` (engine) gains `outputFiles: CapturedFile[] | null` (null = not kept) with
  `CapturedFile = { path, change, sizeBytes, sha256, kept, reason, content, storedBytes,
  redactions }`.
- `AgentAdapter` gains `redactOutput(text)` (FR-123-60).
- Named constants in `benchmark-engine`: `OUTPUT_FILE_MAX_BYTES`, `OUTPUT_RUN_MAX_BYTES`,
  `OUTPUT_REDACTION_MARGIN_BYTES`; in `apps/web/lib`: `FILE_DIFF_MAX_EDIT_LINES`,
  `BLIND_REVIEW_NOTE_MAX_CHARS` (2,000; shared Zod schema).

### 8.3 Repository functions (`@directivebench/database`)

- `insertAgentRun` extended with `outputFiles` (same transaction).
- `listAgentRunFiles(db, agentRunId)` → metadata only (no `content`).
- `getAgentRunFile(db, { benchmarkRunId, agentRunId, path })` → one file with content, or null.
- `startBlindReview(db, benchmarkRunId)` → review id (FR-123-50: conditional insert first,
  eligibility and pair integrity checked inside the same transaction).
- `getBlindReviewForReviewer(db, benchmarkRunId)` → `{ review, pairs: { id, position, caseId,
  verdict, note } }` without variant fields while unrevealed.
- `getBlindPairFiles(db, { benchmarkRunId, position, side })` → file list and content for side
  A or B, with no variant field and no agent-run id.
- `hasUnrevealedBlindReview(db, benchmarkRunId)` → boolean (FR-123-52a).
- `recordBlindVerdict(db, { pairId, verdict, note })` → `recorded | already-decided | revealed |
  not-found` (one conditional `UPDATE … WHERE verdict IS NULL AND review not revealed RETURNING`).
- `revealBlindReview(db, reviewId)` → `revealed | already-revealed | not-found`.
- `getBlindReviewResult(db, benchmarkRunId)` → variant per side and summary counts, only when
  revealed (returns null otherwise).

## 9. Data flow

```mermaid
flowchart LR
    A["Agent (claude or mock), existing"] --> W["Workspace, existing"]
    W --> C["Engine capture (new): manifest diff, bounded read, redactOutput, limits"]
    C --> R["Runner insertAgentRun (changed): agent run + files in one transaction"]
    R --> D[("SQLite: agent_run_files, blind_reviews (new)")]
    D --> P["Web pages (new): files, compare, blind review"]
    P -->|"server actions: start, verdict, reveal"| D
    D --> E["CLI benchmark export (new)"]
```

The workspace is still removed after the agent run; only the captured, redacted, bounded files
outlive it. The web app reads files and writes only blind-review rows, always through
repositories; it never touches the file system or starts a process (SPEC-014 §3.3).

## 10. API and interface design

- Server actions in `apps/web/lib/actions.ts`: `startBlindReviewAction(benchmarkRunId)`,
  `recordBlindVerdictAction({ pairId, verdict, note })`, `revealBlindReviewAction(reviewId)`;
  each parses its input with a Zod schema, calls one repository function, maps the outcome to the
  typed result of SPEC-008 and revalidates the review path.
- Page query parameters (`case`, `left`, `right`, `path`, `pair`, `side`) are parsed with Zod;
  an invalid or foreign value renders not-found, never a different run's data.
- CLI: `directivebench benchmark export <run-id> --out <dir> [--json]` (§6.4).

## 11. UI/UX considerations

Before building, read `apps/web/design-system.md` and the Storybook. Copy uses no en or em dash.

- **Run page**: two new cards below the existing comparison: "Output files" (per case table,
  `Table` with `aria-label`) and "Blind review" (start, continue with "Pairs decided: 2 of 6", or
  the revealed summary). Planned parts are not shown as working.
- **Agent run files** (`/results/[id]/agent-runs/[agentRunId]`): page header names the case,
  variant and repetition ("Candidate (v3), repetition 2"); left a file list (path in
  `font-mono`, change and status as `Badge`s with words, not colour alone); right the file in a
  line-numbered `Pre` with status lines above it (`role="status"` text, FR-123-21). A file with
  CR line endings says "Shown with LF line endings" (lesson 2026-10-20 on carriage returns).
- **Compare** (`/results/[id]/compare`): two `NativeSelect`s (left and right agent run, "Baseline
  repetition 1" style labels), a path list marking "Only left" / "Only right", and the
  side-by-side diff; at 320px the two columns stack (left first) with "Left" and "Right"
  headings.
- **Blind review** (`/results/[id]/blind-review?pair=<n>`): "Pair 3 of 6", the case prompt, a
  path list, side A and side B side by side (stacked at 320px), then the verdict form: three
  `Button`s "A is better", "B is better", "About the same", a `Textarea` "Note (optional)", and a
  `role="status"` line after recording ("Verdict recorded. Next pair"). Navigation "Previous
  pair" / "Next pair" links. "Reveal variants" is a `destructive` `Button` with inline
  confirmation (Risky-action pattern). After the reveal the page shows each side's variant and
  the summary.
- Keyboard: every control reachable; the verdict buttons have accessible names including the
  pair ("A is better, pair 3").
- Contrast: badges and diff markers checked in both themes (AGENTS.md §7).
- New components (A14, ⚠ needs the maintainer's approval): `FileView` (line-numbered text),
  `SideBySideDiff` (two `FileView` columns with aligned change markers) and the file-status badge
  mapping. Each gets stories and a Storybook page per SPEC-122 "Contributing".

Prototype: .ai/specs/assets/agent-run-output-files/ (static mockups rendered by
`om-auto-write-spec`; illustrative layout only, not a design approval and not built from the
design-system components):

- [Run page, output files and blind review cards](assets/agent-run-output-files/mockup-01-run-page-output-files.png)
- [Files of one agent run](assets/agent-run-output-files/mockup-02-agent-run-files.png)
- [Compare two agent runs](assets/agent-run-output-files/mockup-03-compare.png)
- [Blind review pair](assets/agent-run-output-files/mockup-04-blind-review.png)

## 12. Security considerations

- **Agent output is untrusted.** Paths and content are attacker-controlled (a hostile fixture or
  prompt can make the agent write anything). The web app renders them as escaped text only (no
  `dangerouslySetInnerHTML`, no Markdown or HTML rendering, no links built from content); paths in
  URLs are query parameters matched against stored rows, never used as file-system paths.
- **Export** writes untrusted paths to disk: FR-123-42 validation, `resolveInside`, exclusive
  create, empty target directory. The lesson "validate untrusted paths against the narrowest root"
  applies.
- **Secrets**: content is redacted by the adapter's `redactOutput` before persistence (redaction
  at the sink, lesson 2026-10-20); the API key is never in the engine, database or UI. Residual:
  pattern redaction cannot catch every secret shape; the fixture and prompt are the user's own,
  and the agent's environment is allowlisted (SPEC-118 §12). Binary content is never kept.
- **Capture reads**: bounded per file (FR-123-04), symlinks and special files already refused by
  the manifest, reads through the pinned workspace.
- **Blind review integrity**: side assignment with `crypto.randomInt`; unrevealed reads never
  select variant fields; verdict and reveal are single conditional statements (SPEC-014 §3.7).
  Residual: file content itself may name the skill (for example a comment the agent wrote); the
  review page says "Content written by the agent may still hint at the variant."
- Server actions keep the local-mode protections (loopback, Host allowlist, Origin check).

## 13. Error handling

| Failure | Behaviour |
| --- | --- |
| Capture fails (unreadable file, manifest limit) | Agent run unchanged; `output_files_kept = 0`, warning `output-files-not-kept` with a redacted reason; run page says "Output files were not kept for this agent run: <reason>". |
| A file disappears or changes between manifest and read | The capture fails as in the row above (fail closed: a workspace that changes after the agent stopped is not trustworthy evidence). |
| Export target not empty / exists as a file | Exit 2, nothing written. |
| Export write error mid-way | Exit 1, message names the directory and the last file written; nothing is deleted. |
| Verdict on a decided pair or a revealed review | Action returns `already-decided` / `revealed`; the page shows "This pair already has a verdict." / "This review was revealed; verdicts are closed." |
| Start review with no eligible pair | Button not offered; a forged action returns "No pair of completed agent runs with kept files." |
| Run or agent run not found / foreign ids | Not-found page. |

## 14. Edge cases

- Capture on a timed-out agent whose process did not exit: not attempted (FR-123-01); the page
  says "Output files were not kept: the agent did not stop after its timeout."
- Agent changes no file: `output_files_kept = 1`, "The agent did not change any file."
- Agent rewrites a file with identical bytes: not in the change list (hash equal), as today.
- Thousands of files (`npm install` by the agent): the manifest limits (5,000 files, 100 MiB)
  still apply; within them, A4 keeps the small files and marks the rest `run-limit`.
- One side of a compare lacks the path: shown as "Not present in this agent run".
- File with a very long line: `Pre` scrolls horizontally inside its column; the page never
  scrolls horizontally at 320px.
- Both variants produced identical files: the diff says "The files are identical."
- A pair where only one side is `completed`: excluded from the blind review (A8), counted as
  "1 pair excluded: an agent run did not complete".
- Benchmark run still running: no blind review start; files of finished agent runs are already
  readable.
- Redaction marker inside the agent's own text (`[REDACTED]` written by the agent): counted only
  for markers the redaction added (count before and after).

## 15. Testing strategy

- Unit (`benchmark-engine`): capture with limits (exact boundaries 1 MiB and 10 MiB, multi-byte
  characters at the cut, ascending-size order), binary and NUL detection, artifact-path exclusion,
  redaction with a known secret straddling the cut, failure path keeping the run status.
- Unit (`agent-adapters`): `redactOutput` of both adapters.
- Unit (`database`): migration up/down pinned to its journal prefix (lesson 2026-10-22),
  cascade removal, repository functions, conditional verdict and reveal (including a concurrent
  second call), unrevealed reads selecting no variant field (asserted on the returned keys).
- Unit (`apps/web/lib`): diff (identical, disjoint, above the bound), Zod schemas, action outcome
  mapping.
- Unit (`apps/cli`): export layout, manifest, unsafe paths (`..`, absolute, backslash, NUL),
  non-empty target, read-only database refusal.
- Playwright (`apps/web/e2e`): files page, compare page, blind review start, verdict, reveal,
  keyboard-only, 320px, both themes, driven by a mock-agent run.
- Storybook: new components in both themes with axe.

## 16. Acceptance criteria

- [ ] AC-1: After a mock or fake-`claude` run, every changed text file up to 1 MB is readable in
  full on the run page for each case, variant and repetition.
- [ ] AC-2: A file over 1 MB is cut at 1 MB and says so; an agent run over 10 MB marks the files
  cut or not kept by the run limit.
- [ ] AC-3: A planted secret (known key and a token pattern) in an output file is stored and shown
  redacted, with the redaction count.
- [ ] AC-4: Binary, deleted and artifact files are listed as not kept, with the reason.
- [ ] AC-5: The compare page shows the same path of two agent runs side by side with a bounded,
  accessible diff.
- [ ] AC-6: `benchmark export` writes the files and manifest; unsafe paths are refused and listed;
  a non-empty target is refused.
- [ ] AC-7: A blind review shows no variant information and no agent-run id before the reveal
  (asserted on the HTML, the RSC payload and the repository result), labelled views are closed
  while it is unrevealed, records immutable verdicts, and reveals all pairs at once with
  the summary.
- [ ] AC-8: Removing a benchmark run row removes its files, review and pairs (cascade test).
- [ ] AC-9: Score, verdict and display status of a run are identical with and without capture
  (regression test on a stored mock run).

## 17. Dependencies

- SPEC-118 (Claude Code adapter, `installedPaths`, redaction of traces), SPEC-112 (pairs,
  interleaving), SPEC-110 (workspace lifecycle), SPEC-113 (run page), SPEC-006 (schema; update
  its table list in the implementation PR), SPEC-007 and SPEC-014 (security and engineering
  rules), SPEC-122 (design-system contribution for new components).
- No new package dependency.

## 18. Open questions

None blocking. The autonomous defaults are listed in §5a; A14 needs the maintainer's
confirmation before Phase 3 starts.

## 19. Future extensions

- Rendered Markdown view of an output file (with the existing safe `Markdown` component) next to
  the raw view.
- Blind export (`benchmark export --blind`) with a sealed side key, for review outside the app.
- Restarting or discarding a blind review; several reviewers.
- Aggregating blind verdicts into a D03 observation (after D03/Q05).
- A run-deletion action (cascade already covers the files).

## 20. Implementation status

- **Implemented:** none.
- **Partially implemented:** none.
- **Not implemented:** everything in this spec. Today `changedFiles` (paths only) is stored and
  workspaces are removed after each agent run.

## 21. Phasing and implementation plan

Each phase is one PR and leaves the app working. Order: Phase 1, then Phase 2 (needs 1) and
Phase 3 (needs 1 and A14) in either order, then Phase 4 (reuses Phase 3's `FileView`), then
Phase 5 (reuses Phase 4's diff, adds migration `0004`).

### Phase 1: Capture and storage

1. Migration `0003` and Drizzle schema for `agent_runs.output_files_kept` and `agent_run_files`;
   migration up/down test; cascade test.
2. `AgentAdapter.redactOutput` in the contract, the mock agent and the Claude Code adapter, with
   tests.
3. Engine capture (`captureOutputFiles` in `benchmark-engine/src/files.ts` or a new
   `output-files.ts`): limits, order, UTF-8/NUL check, artifact-path exclusion, redaction, failure
   path; wired into `runAgent` before the overlay for `completed`, `agent-error`, `timeout`.
4. Runner: `insertAgentRun` stores files in the same transaction; repository read functions
   `listAgentRunFiles`, `getAgentRunFile`.
5. Verify with `directivebench demo` that a mock run stores files and scores are unchanged
   (AC-9).

### Phase 2: CLI export

1. `benchmark export` command, path validation, manifest, summary and `--json`; tests for unsafe
   paths and refusals.
2. Verify on a demo run; `pnpm build && pnpm verify:pack`.

### Phase 3: Run page and files page (after A14 is confirmed)

1. `FileView` component with stories; status badge mapping.
2. "Output files" card on `/results/[id]`; `/results/[id]/agent-runs/[agentRunId]` page;
   Playwright tests.

### Phase 4: Compare

1. Bounded line diff in `apps/web/lib` with unit tests.
2. `SideBySideDiff` component with stories; `/results/[id]/compare` page; Playwright tests.

### Phase 5: Blind review

1. Migration `0004` for `blind_reviews` and `blind_review_pairs`; repository functions with conditional
   verdict and reveal; tests including concurrency and no-variant-field reads.
2. Server actions with Zod schemas; blind review page, run-page card, closing of labelled views
   (FR-123-52a); Playwright flow test (start, verdict, reveal, keyboard, 320px, both themes) that
   asserts no agent-run id or variant label appears in the HTML or the RSC payload before the
   reveal.
3. Browser QA agent and Codex review per AGENTS.md §2.14 for Phases 3 to 5.
