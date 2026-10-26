---
title: 'Issue #103 — opt-in Claude Code live check (subscription mode) and the fixes it forced'
date: 2026-10-26
agent: Claude Code / claude-opus-5-5
trigger: 'Issue #103; maintainer go-ahead after his plan limit renewed; decisions 2026-10-26 on FR-118-08 and FR-118-09'
status: completed
branch: test/issue-103-live-check
specs: [SPEC-118, SPEC-203]
---

# Run: Issue #103 — Claude Code live check

## Objective

Run the opt-in live check of SPEC-118 AC-22 with the exact production argv against the real `claude` (2.1.302), record the field names the specs marked as assumptions, and act on what it refutes. API Key Mode was out of scope for this run (no key in the environment).

## Plan

1. Write the harness: `packages/agent-adapters/test/claude-code/live.test.ts`. It runs only with `DIRECTIVEBENCH_LIVE_TESTS=claude-code` and never in CI. It uses `buildClaudeArgv`, `buildClaudeEnv` and `runClaudeProcess` directly, because it plants what the adapter's pre-spawn inspection would refuse: a second project skill and a `!` placeholder.
2. Run it in Local Subscription Mode, review the report and the redacted stream.
3. Fix what the live check refutes, after maintainer decisions. Re-run it with the final argv and record the results in SPEC-203.

## Decisions

- **FR-118-08 (maintainer, 2026-10-26).** The `Skill(<name>)` allow rule does not deny other skills. Decided:
  - add `disableBundledSkills: true` to the run settings;
  - record `skillActivation.otherSkillsInvoked`;
  - make a benchmark run `not-comparable` (`other-skill-invoked`) when any agent run invoked another skill.
- **FR-118-09 (maintainer, 2026-10-26).** An inline `/<name>` leaves no trace in the stream. A `/<name>` prompt now counts as an invocation when the skill is loaded and listed in `slash_commands`; this is recorded as `slashInvocation: 'inferred'`.
- **Added without asking: `autoMemoryEnabled: false`.** The init event advertised an auto-memory directory under the user's `~/.claude/projects`, so notes could carry from one agent run into the next. This is the same isolation concern as above, and it is reversible.

## Work performed

1. Harness and first run: 2 sessions. Findings:
   - the other skill was invoked;
   - the slash expansion signal was absent;
   - an outside write was only tested through overwrite, so a "create new file outside" step was added.
2. Experiments with modified settings: 2 sessions. `permissions.deny` `Skill(<other>)` and `skillOverrides` `"off"` both stop a named skill. `disableBundledSkills` removes most bundled skills.
3. Second run with the outside-create step: 1 session. Creating a new outside file is denied.
4. Code changes:
   - `CLAUDE_CODE_RUN_SETTINGS`: `disableBundledSkills`, `autoMemoryEnabled: false`.
   - Parser: tracks other-skill calls until their result; `slash_commands` → `slashCommandListed`; `slashInferred`.
   - Normalizer: `otherSkillsInvoked`; `slashInvocation`. An inferred slash expansion counts only when the skill is loaded.
   - `SkillActivation`: two optional fields, so traces recorded before keep parsing.
   - Engine: `other-skill-invoked` comparability issue.
5. Recorded fixtures `live-subscription-confine.ndjson` and `live-subscription-slash.ndjson`, redacted: tmp paths and the home path normalised, plan-usage numbers zeroed, messaging socket path replaced. Tests use them.
6. Final live run with the production argv: 2 sessions, both scenarios pass.
7. SPEC-203 §11 live results, the `--setting-sources` row, and SPEC-118 FR-118-08/09 updated.

## Verification

- Live check: `DIRECTIVEBENCH_LIVE_TESTS=claude-code pnpm --filter @directivebench/agent-adapters exec vitest run test/claude-code/live.test.ts` passed 2/2 on the final argv.
- Red first: with `src` reverted, 17 agent-adapters tests and 2 benchmark-engine tests fail, including both tests on the recorded live streams.
- Gate: see the PR.
- In CI the harness is skipped (2 skipped tests). The callback resolves `claude` lazily, so a machine without `claude` still collects the file.
- **Not verified:** API Key Mode (AC-22 stays open); macOS and Windows; whether `design`, `doctor` and `plugin-authoring` can be disabled by setting.

## Problems and deviations

- While the user-level skill was planted (during a run), it briefly appeared in this Claude Code session's own skill list. The harness removes it in `finally`, and it was confirmed gone afterwards.

## Review

- Codex adversarial review round 1, on PR #126:
  - **high:** a prompt `/<other skill>` and a forked run of another skill were not detected as another skill used. The parser now records both. A `/<other>` prompt counts when `system/init` lists the name in both `skills` and `slash_commands`, so built-in commands such as `/compact` do not count. Red first: both new tests fail on d263374.
  - **medium:** the harness ran whenever `DIRECTIVEBENCH_LIVE_TESTS` was set. A set `CI` variable now always vetoes it.

## Lessons recorded

- [An allow rule does not restrict a tool that needs no permission](../lessons/2026-10-26-an-allow-rule-does-not-restrict-a-tool-that-needs-no-permission.md)

## Follow-ups

- Run API Key Mode: the maintainer sets `ANTHROPIC_API_KEY` in his shell and runs `DIRECTIVEBENCH_LIVE_AUTH=api-key`. Then tick AC-22.
- Investigate whether the remaining listed skills (`design`, `doctor`, `plugin-authoring`) can be turned off. Today they are only detected.
