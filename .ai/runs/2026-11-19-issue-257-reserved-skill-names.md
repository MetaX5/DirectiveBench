---
title: Refuse a skill named like a name Claude Code lists itself (issue 257)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #257, maintainer decision 2026-11-17, started while PR #272 was open (approved)
status: in-progress
branch: feat/issue-257-reserved-skill-names
specs: [SPEC-203, SPEC-118]
---

# Run: Refuse a skill named like a name Claude Code lists itself (issue 257)

## Objective

Refuse, with the new code `skill-name-reserved`, a `skill-md` artifact whose resolved install
name is one Claude Code lists itself, at plan time (`checkSuite`) and in `ClaudeCodeAdapter.run`,
before any `claude` process starts. The names are a static constant documented for one `claude`
version. A run-time check against `system/init` is a separate follow-up issue.

## Plan

1. Red-first tests: the constant and the check (`reserved-skill-name.test.ts`), the adapter with
   the fake `claude` (candidate and baseline), and `benchmark run` at plan time.
2. `CLAUDE_RESERVED_SKILL_NAMES`, `CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION` and
   `assertClaudeSkillNameNotReserved` in `claude-code/skill-name.ts`, called by
   `claudeSkillInstall` (so `claudeArtifactProfile`, `claudeSkillName`, `baselineSkillNameIssue`
   and the install refuse) and by `buildClaudeArgv`; new `ClaudeCodeErrorCode`.
3. SPEC-203 §4.1 and §9, SPEC-118 FR-118-08 and §13 error table, implementation status.
4. Follow-up issue for the run-time check; gate; real CLI run; Codex review; draft PR;
   `om-auto-review-pr`.

## Decisions

- The check sits in `claudeSkillInstall`, right after the name-form check, so every path that
  resolves a skill name refuses it: `checkSuite` (via `claudeArtifactProfile` and
  `baselineSkillNameIssue`) and the adapter (same calls, before `claude` is located). The argv
  builder checks again, like the form check.
- Reserved list, documented for `claude` 2.1.302 (SPEC-203 §11 live check, 2026-10-26):
  - skills still listed with `disableBundledSkills: true`: `design`, `doctor`,
    `plugin-authoring` (SPEC-203 §11);
  - `checkup`, the unlisted `/checkup` alias of `doctor` (issue 103 run log; the stream parser
    already treats it as another skill);
  - built-in slash commands: the recorded `system/init` `slash_commands` minus its `skills`
    (`live-subscription-*.ndjson`), without `__remote-workflow`, which is not a valid skill name.
  - Not reserved: bundled skills that `disableBundledSkills` removes (the recording lists them
    because it predates the setting), and interactive-only commands a print-mode session does not
    list. No real `claude` was run and no public docs list was added: the list is what a run's
    session lists, and the recording is that evidence.
- `BACKWARD_COMPATIBILITY.md` needs no change: a new refusal code is human-readable CLI output
  (exit 2 is unchanged), and a job enqueued before the upgrade for such a skill ends
  `infrastructure-error` with the code, which §5 allows ("mark such jobs failed with a clear
  reason").

## Work performed

See the PR commits.

## Verification

- Red first (old code, new tests): 7 of 8 `reserved-skill-name.test.ts` tests fail (exports
  missing); both adapter tests fail with `status: 'agent-error'` (the fake `claude` was started);
  the CLI test fails with "expected null to be an instance of CliError" (the plan accepted the
  skill).
- `pnpm lint && pnpm typecheck && pnpm test`: pass, 100% coverage in all 7 packages.
- `pnpm build && pnpm verify:pack`: pass.
- Real CLI (`apps/cli/dist/cli.js`, data directory under `/var/tmp`, fake `claude` on `PATH`,
  skill `doctor` seeded with `importArtifactVersion`): `benchmark run <suite> --artifact doctor
  --yes` printed `Refused (skill-name-reserved): The skill name "doctor" is a name Claude Code
  2.1.302 lists itself …` and exited 2; jobs, benchmark runs and suites stayed 0; the fake's
  records directory stayed empty.
- Not verified: a real `claude` session; which skill wins on a collision; a `claude` newer than
  2.1.302; e2e and Storybook (no UI change).

## Problems and deviations

- The recorded 2.1.302 `system/init` lists 21 skills although the run settings disable bundled
  skills: the recording predates the setting (lesson below).

## Lessons recorded

- [2026-11-19-recorded-init-predates-final-run-settings](../lessons/2026-11-19-recorded-init-predates-final-run-settings.md)

## Follow-ups

- #275: run-time check against the session's `system/init` `skills` and `slash_commands`.
