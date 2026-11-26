---
id: SPEC-128
title: Check the base directory of an invoked skill against the installed one
status: draft
created: 2026-11-26
updated: 2026-11-26
category: feature
related: [SPEC-203, SPEC-118, ADR-0015]
---

# SPEC-128: Check the base directory of an invoked skill against the installed one

## 📝 TLDR

A skill author benchmarking a `skill-md` artifact on `claude-code` cannot tell from a run whether
the session ran **their** installed skill or a same-named skill that Claude Code owns. Today the
reserved-name defences are a static plan-time list, a `system/init` check and, for A/B runs, one
session without the skill (SPEC-203 §4.1, ADR-0015). This spec proposes a further run-time check:
when the stream shows the installed skill being invoked, the adapter reads the
`Base directory for this skill: <path>` line that Claude Code puts in front of the loaded skill
body. If that path is not the run's own `.claude/skills/<dir>`, the agent run ends
`infrastructure-error` with the existing stop code `skill-name-reserved`. This is hardening
behind issue 280's check, not a replacement (issue #288). **Limit:** it catches a skill that loads
from **another directory** (a user-level `~/.claude/skills` entry in subscription mode, a parent
`.claude/skills`, a plugin). A skill compiled into the `claude` binary probably prints no line at
all, and then the check does not run (A2).

## Resolved assumptions (autonomous defaults)

| # | Question | Default chosen | Rationale |
|---|---|---|---|
| A1 | What does a mismatch end the run with? | `infrastructure-error` with the **existing** stop code `skill-name-reserved` (SPEC-118 FR-118-15) | The meaning is the same as the other reserved-name checks: the run measured a skill other than the tested one. This adds no new error code, no web label and no database value. |
| A2 | What does a missing line do (the text is undocumented)? | Nothing fails. One trace message notes that the check did not run. | Failing closed when the wording changes would refuse every run that invokes the skill. A trace note keeps the blind spot visible without a new warning value, which would be a contract change in the web app. **Trade-off:** a skill bundled in the binary, the most likely real collision, probably prints no line, so this check does not catch it. The issue 280 session and the `system/init` check stay the defence there. A stricter variant was rejected as the default: fail closed when the installed skill's invocation is unreported but the same session reported a line for another skill. It is sound only without forked skills, and no recording shows a forked invocation. |
| A3 | Which invocations are checked? | Only invocations of the installed skill that the stream **shows**: a successful `Skill` tool call (main conversation), or an observed `/<name>` expansion (`slashExpanded`) | These are the only cases where the line appears in the recordings. Inferred expansions (`slashInferred`), forked skills and built-in commands that are not skills show no line, so they are out of scope (as issue #288 says). |
| A4 | Is a consented live check needed first? | No. Phase 1 uses recording-derived streams only. A live check of a real collision stays a follow-up. | Detection does not depend on which entry wins a collision: any other directory is a mismatch. Real `claude` sessions need the maintainer's explicit go-ahead. |
| A5 | Which path counts as the installed one? | `<workspace canonical path>/.claude/skills/<dir>`, where `<dir>` comes from the exact `.claude/skills/<dir>/SKILL.md` entry of `request.installedPaths`, which also covers an A/B baseline version and a nameless skill's folder. Both sides are compared lexically after `path.normalize`, with trailing separators removed. Comparison is case-insensitive only on `win32`. A reported path that is not absolute is a mismatch and is never resolved. | `claude` runs with `cwd` = the `realpath` of the workspace (`workspace-pin.ts`, `run.ts`), and `PWD` is not passed (`env.ts`), so the CLI has no other spelling to start from. Install refuses links, so the directory has no other spelling either. The recordings' paths were normalised when they were committed, so they show the shape of the line, not the exact bytes. |
| A7 | Which messages may carry the line? | Only the **first text block of the user event directly after** the user event that holds the installed call's successful `tool_result`, and only when that event has `isSynthetic: true`. Not when another `Skill` result in the same or an earlier event is still waiting for its body text (parallel calls). Anything else counts the invocation as unreported. Non-message events (`system`, `rate_limit_event`, thinking) do not end the wait. | Parallel `Skill` calls in one turn would otherwise attach another skill's body, which would be a false stop. `isSynthetic` is the CLI's own marker on the real line (`live-subscription-confine.ndjson`), so neither model output nor tool output can forge it. |
| A6 | New ADR? | No. SPEC-203 §4.1 gets a paragraph and an error-table entry in the implementation PR. | The check reuses ADR-0015's rationale and code. No new contract. |

## 📝 Problem Statement

- The name collision check of issue 280 runs one extra session without the skill before an A/B
  run. It relies on `system/init` listing a CLI-owned name. The live check on `claude` 2.1.325
  showed that an installed skill and a CLI-owned one with the same name are listed **once**, so
  a run with the skill installed cannot tell them apart from `system/init` alone.
- When the skill is actually invoked, the stream carries direct evidence of **which** skill
  loaded. In the 2.1.302 recordings (`test/fixtures/claude-code/2.1.302/live-subscription-confine.ndjson`,
  real; `slash-expanded.ndjson`, derived), the event right after the `Skill` tool result (or after
  the `/<name>` expansion) is a main-conversation user message. Its first text block starts with
  `Base directory for this skill: /…/workspace/.claude/skills/<dir>`, on an event with
  `isSynthetic: true`. The real slash recording (`live-subscription-slash.ndjson`) shows no
  expansion message at all. So the `/<name>` branch below has no real evidence and is
  **unverified**: it is checked only when an expansion is observed.
- Nothing reads that line today, so a CLI-owned skill that loads under the tested name would
  produce a result that looks valid.

## 📝 Proposed Solution

1. **Stream parser** (`packages/agent-adapters/src/claude-code/stream-parser.ts`). After an
   observed invocation of the installed skill (A3), take the user event that follows, under the
   rules of A7. If its first text block starts with `Base directory for this skill: `, record the
   rest of its first line as one reported base directory. The line is taken from the **raw**
   text, not the redacted and clipped trace copy, and a trailing `\r` is removed. An assistant
   message, a user event that breaks A7, or a text without that prefix ends the wait and counts
   the invocation as **unreported**. New parsed facts:
   `skillBaseDirectories: string[]` (bounded by `CLAUDE_STREAM_MAX_NAMES`; more set an overflow
   flag), `skillBaseDirectoryOverflow: boolean`, and `unreportedSkillBaseDirectories: number`.
   A path longer than the new named limit `CLAUDE_STREAM_MAX_PATH_CHARS` (4 096) is clipped and
   marked, so it can never compare equal.
2. **Outcome** (`normalize.ts`). A new pure function `claudeSkillBaseDirectoryMismatch(parsed,
   conditions)` returns a message or null. It compares each reported directory with
   `conditions.skillBaseDirectory` (A5). `claudeRunOutcome` applies it **after**
   `claudeSkillNameCollision`, with the same effect: status `infrastructure-error` and code
   `skill-name-reserved`. The error names the expected and the reported directory, then gives the
   existing rename hint. It says that a skill of the same name **from another place** loaded
   (possibly the user's own skill), never that Claude Code lists the name. The message is
   redacted like every error (`adapter.ts` `finish()`). An overflow fails closed the same way. Unreported invocations add one
   trace message (A2).
3. **Adapter** (`adapter.ts`). It passes `skillBaseDirectory` in `ClaudeRunConditions` for a
   `skill-md` run that installed the skill. The value is the canonical workspace path joined with
   the directory of the `.claude/skills/<dir>/SKILL.md` entry in `request.installedPaths` (A5). Runs that installed nothing
   (`none` baseline) and instruction formats pass nothing, and the check does not run.

**Alternatives considered.**

- *A new error code* (e.g. `skill-shadowed`): clearer in logs. But it is a new contract (error
  union, web labels, stop-code list) for the same meaning, so it lost to A1.
- *Fail closed on a missing line*: rejected, because the line's wording is undocumented (A2).
- *Matching on the directory name only* (`basename === <dir>`): weaker. A CLI-owned skill may
  live in a directory with the same name. The full path is what proves the source.
- *`realpath` on the reported path*: the parser and normalisation stay pure and run after the
  process ends. A5 shows that the lexical comparison is exact for the path forms `claude`
  prints, so a file system call adds risk without evidence.

## 📝 Architecture

- Changed: `stream-parser.ts` (new facts), `normalize.ts` (new check, applied in
  `claudeRunOutcome`), `adapter.ts` (one new condition). Reused: `skill-name-reserved`, its
  stop-code handling in the benchmark engine (SPEC-118 FR-118-15) and the `RENAME_HINT` text.
- Consumers: `claudeRunOutcome`'s result goes to the benchmark engine unchanged in shape. No
  change in `benchmark-engine`, `runner`, `database` or `apps/web`. The trace message is ordinary
  trace text.
- The mock agent is untouched. Its runs never pass `skillBaseDirectory`.

## 📝 Data Model

None. No schema, migration or stored value changes. `skill-name-reserved` already exists in the
error-code union and in storage.

## 📝 API Contracts

Package-internal only:

- `ParsedClaudeStream` gains `skillBaseDirectories`, `skillBaseDirectoryOverflow` and
  `unreportedSkillBaseDirectories` (additive).
- `ClaudeRunConditions` gains optional `skillBaseDirectory?: string` (additive; absent = no
  check).
- New export `claudeSkillBaseDirectoryMismatch` and constant `CLAUDE_STREAM_MAX_PATH_CHARS`.

## 📝 Edge Cases & Failure Scenarios

| Case | Behaviour |
|---|---|
| Installed skill invoked, line names the installed directory | Run continues as today |
| Line names another directory (e.g. a CLI-owned skill's) | `infrastructure-error`, `skill-name-reserved`; the benchmark stops further agent runs (FR-118-15) |
| Invoked twice, second invocation names another directory | Mismatch (every reported directory is checked) |
| Invocation with no line (wording changed, forked skill, skill bundled in the binary) | No failure; one trace message "the installed-directory check did not run" |
| Two `Skill` calls in one turn (installed and another) | When the body texts cannot be matched to calls (A7), the invocation is unreported, never a mismatch |
| Base-directory text without `isSynthetic: true` | Not accepted: unreported |
| Reported path not absolute | Mismatch (never resolved against DirectiveBench's own working directory) |
| Line ending in `\r` | Stripped before comparison |
| Line for **another** skill (`db-live-other` in the recording) | Ignored: only lines after an invocation of the installed skill are read |
| Failed `Skill` call (`is_error: true`) | No wait starts; nothing is checked |
| Path with a trailing separator, or `\` on Windows | Normalised before comparison (A5) |
| Path longer than `CLAUDE_STREAM_MAX_PATH_CHARS` | Clipped and marked, so it never equals the expected path: mismatch (fail closed) |
| More than `CLAUDE_STREAM_MAX_NAMES` reported directories | Overflow: mismatch (fail closed) |
| Inferred `/<name>` expansion (`slashInferred`) | No line in the stream, no wait: out of scope |
| `none` baseline (nothing installed) | No `skillBaseDirectory`, so no check (the `system/init` check of issue 275 covers it) |
| Run also hit a name collision | The collision message wins (applied first); same code |

## 📝 Risks & Impact Review

- **False refusals stop benchmarks.** `skill-name-reserved` is a stop code, so a path-form
  difference that A5 missed would refuse every run that invokes the skill. Evidence for A5 is
  one real 2.1.302 Linux recording. macOS (`/tmp` → `/private/tmp`) is covered because `cwd` is
  already the canonical path. Windows (`claude` on Windows is not a target, NFR-118-04) gets
  case-insensitive comparison. Rollback: drop `skillBaseDirectory` from the adapter conditions.
  That is one line, and no data needs migrating.
- **Undocumented text.** A wording change silently turns the check off (A2). The trace message
  makes it visible per run.
- **Unverified collision behaviour.** No recording shows a colliding name being invoked, so the
  check's positive case is tested with derived streams only (A4).
- **Limited reach.** The check does not cover a skill compiled into the binary that prints no
  line (A2). It is not a replacement for the issue 280 session.

## 📋 Phasing

One phase. The check is small, internal to `agent-adapters`, and shippable on its own.

## 📋 Implementation Plan

**Phase 1: base-directory check (one PR, `Closes #288`).**

1. Parser facts: the wait after an observed installed-skill invocation, the
   `Base directory for this skill: ` prefix, `skillBaseDirectories`, the overflow, the unreported
   count and `CLAUDE_STREAM_MAX_PATH_CHARS`. Tests in `stream-parser` on streams derived from
   `live-subscription-confine.ndjson` and `slash-expanded.ndjson` (the latter given
   `isSynthetic: true`): matching line; other skill's line ignored; parallel `Skill` calls
   (unreported); missing `isSynthetic`; failed call; no line (`skill-invoked.ndjson`, a fixture whose invocation carries no line);
   `\r`; over-long path; overflow.
2. `claudeSkillBaseDirectoryMismatch` and its use in `claudeRunOutcome` (after the collision
   check), plus the trace message for unreported invocations. Unit tests in `normalize`: match,
   mismatch, normalisation (trailing separator; `win32` case), relative reported path, overflow,
   collision precedence, no condition (no check).
3. Adapter: pass `skillBaseDirectory` from the canonical workspace path and the installed
   `SKILL.md` path. Adapter test with the fake `claude` replaying a derived stream whose base
   directory is outside the workspace: `infrastructure-error`, `skill-name-reserved`. A replay of
   the unchanged recording still passes.
4. Docs: SPEC-203 §4.1 paragraph "Base directory of an invoked skill (issue 288)" and the error
   table entry; this spec's implementation status; run log.

Each step leaves the suite green at 100% coverage. No real `claude` session is started.

## Acceptance criteria

- [ ] AC-1: An invoked installed skill whose reported base directory is not
  `<canonical workspace>/.claude/skills/<dir>` ends the agent run `infrastructure-error` with
  `skill-name-reserved`, tested with a recording-derived stream through the fake `claude`.
- [ ] AC-2: The unchanged 2.1.302 recordings (`live-subscription-confine`, `slash-expanded`)
  still pass the check.
- [ ] AC-3: An invocation without the line (`skill-invoked.ndjson`) does not fail the run and adds
  the trace message.
- [ ] AC-6: Parallel `Skill` calls whose body texts cannot be matched, and lines without
  `isSynthetic: true`, are unreported, never a mismatch.
- [ ] AC-4: Lines of other skills, failed calls, `none` baselines and instruction formats are
  not checked.
- [ ] AC-5: Over-long paths and more than `CLAUDE_STREAM_MAX_NAMES` reported directories fail
  closed.

## Implementation status

- **Not implemented:** everything above (design only).
