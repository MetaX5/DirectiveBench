---
title: Refresh the reserved skill-name list for claude 2.1.325 (issue 278)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #278, approved by the maintainer; run as a subagent with om-auto-fix-issue
status: completed
branch: fix/issue-278-reserved-names-2-1-325
specs: [SPEC-203, SPEC-118]
---

# Run: Refresh the reserved skill-name list for claude 2.1.325 (issue 278)

## Objective

Update `CLAUDE_RESERVED_SKILL_NAMES` and `CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION` together from
the recorded 2.1.325 `system/init` (issue 275 live check), with the derivation rules of issue 257,
keeping the names only older versions list. Acceptance: a skill named `ultrareview` is refused at
plan time with `skill-name-reserved`; a test derives the CLI-owned names from the recording so the
next refresh is mechanical.

## Plan

1. Red-first tests in `reserved-skill-name.test.ts`: version 2.1.325; every CLI-owned name of the
   2.1.325 recording (and the built-in slash commands of the 2.1.302 recordings) is in the
   constant; `ultrareview` refused by the adapter before the spawn.
2. Update the constant and its documentation (per-version sources).
3. Move the run-time-check tests (issue 275) that used `ultrareview` as "a name the static list
   misses" to a constructed variant of the recording.
4. SPEC-203 §4.1, §9 table row, implementation status; SPEC-118 FR-118-08.
5. Gate, real CLI run, Codex review, draft PR, `om-auto-review-pr`.

## Decisions

- Derivation for 2.1.325 (issue 257 rules applied to a session that ran with
  `disableBundledSkills: true`): every name in `skills`, `slash_commands` and
  `terminal_slash_commands`, minus the installed test skill `doctor` (a colliding name is listed
  once, issue 275, so the entry cannot be attributed to the CLI from this recording; 2.1.302
  lists `doctor` anyway) and minus `__remote-workflow` (not a valid skill name). Result: every
  2.1.302 name except `checkup` (an unlisted alias in both versions), plus `ultrareview`.
- The list stays a union: no 2.1.302 name was dropped (2.1.325 drops none of them anyway).
- The 2.1.302 recordings predate `disableBundledSkills`, so their test only counts the
  `slash_commands` that are not `skills`, as issue 257 did.
- The issue 275 tests that need "a built-in the static list misses" now replace `ultrareview` in
  the recording with `newer-built-in` (labelled as constructed, not recorded), so the run-time
  check keeps its coverage after the refresh.
- The refusal message keeps its form and now names 2.1.325.

## Work performed

1. `fix(agent-adapters)`: the constant, its documentation and the tests.
2. `docs`: SPEC-203 §4.1, §9 row and implementation status; SPEC-118 FR-118-08; this run log;
   lesson.
3. Draft PR; Codex adversarial review; `om-auto-review-pr` as a COMMENT review.

## Verification

- Red first (old `skill-name.ts`, new tests): 7 of 56 tests in `reserved-skill-name.test.ts`,
  `adapter.test.ts` and `runtime-reserved-name.test.ts` fail, among them "covers every CLI-owned
  name the recorded 2.1.325 session start lists" (`expected [ 'ultrareview' ] to deeply equal []`)
  and "refuses a candidate named like the 2.1.325 built-in `/ultrareview` before the spawn".
- `pnpm lint && pnpm typecheck && pnpm test --force`: pass, 100% coverage in all 7 packages (cli
  210, agent-adapters 398 + 2 skipped, benchmark-engine 526, core 353, database 385, runner 313,
  web 655).
- `pnpm build && pnpm verify:pack`: pass.
- `pnpm format:check`: failed on three changed test files (found by Codex round 1), fixed with
  Prettier in a style commit; passes now, and the `claude-code` tests still pass.
- Codex adversarial review (`--scope branch --base origin/main`): round 1 `needs-attention`
  (formatting only, no material finding); round 2 `approve`, no findings.
- Real CLI (`apps/cli/dist/cli.js`, data directory under `/var/tmp`, skill `ultrareview` seeded
  with `importArtifactVersion` by a temporary vitest file, deleted; a fake `claude` 2.1.325 on
  `PATH` that logs every call): `benchmark run <suite> --artifact ultrareview --yes` printed
  `Refused (skill-name-reserved): The skill name "ultrareview" is a name Claude Code 2.1.325 lists
  itself ...` and exited 2; jobs, benchmark runs and suites stayed 0; the fake was never called.
- Not verified: a real `claude` session (the issue 275 recording is the evidence); interactive-only
  commands that a print-mode session does not list; e2e and Storybook (no UI change).

## Problems and deviations

- `pnpm format:check` is not part of the documented gate; Codex caught the formatting.
- The issue 275 tests that used `ultrareview` as the name the static list misses would have been
  refused at plan time after the refresh; they now use a constructed variant of the recording.

## Lessons recorded

- [2026-11-19-tests-of-a-static-list-gap-construct-the-gap](../lessons/2026-11-19-tests-of-a-static-list-gap-construct-the-gap.md)

## Follow-ups

- None. The next `claude` version: add its recorded session start to `reserved-skill-name.test.ts`
  and update the constant until the test passes.
