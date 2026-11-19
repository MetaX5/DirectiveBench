---
title: Warn in the benchmark plan when a /<name> prompt no longer names the installed skill
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue #258 via om-auto-fix-issue (follow-up of issue 245, decision 7)
status: completed
branch: feat/issue-258-plan-warns-stale-slash-prompt
specs: [SPEC-118, SPEC-203]
---

# Run: Warn in the benchmark plan when a /<name> prompt no longer names the installed skill

## Objective

`directivebench benchmark run` prints, beside `Skill name:`, a warning for each suite case whose
prompt starts with `/<x>` where `x` is not the installed skill name. The warning names the case
and the installed name; the run is not refused.

## Plan

1. Spec: SPEC-118 FR-118-31 and the consequences paragraph of SPEC-203 §4.1.
2. Red-first tests: `planText` in `apps/cli/test/benchmark-report.test.ts` and one
   `apps/cli/test/benchmark-run.test.ts` case with the fake `claude`.
3. Implement in `planText` (`apps/cli/src/benchmark-run.ts`) with `claudeSkillName` and
   `promptInvokesSkill` from `@directivebench/agent-adapters`.
4. Gate, real CLI run with a fake `claude`, Codex adversarial review, `om-auto-review-pr`.

## Decisions

- One `Warning:` line per affected case, inserted directly after `Skill name:`. Case ids are
  validated slugs, so they are printed as is; the prompt text itself is not echoed (it is
  untrusted suite content and may be long).
- Any `/command` that does not invoke the installed name warns, not only the old slug: the
  consequence (no explicit invocation) is the same.
- `planText` rather than `checkSuite`: the warning is plan copy, and `checkSuite` only refuses.

## Work performed

1. `f6c3d53` docs(specs): SPEC-118 FR-118-31 and SPEC-203 §4.1 describe the warning; run log.
2. `b3da93f` feat(cli): `planText` prints the warning; tests in `benchmark-report.test.ts` and
   `benchmark-run.test.ts` (fake `claude`). The existing issue 245 `planText` test fixture gained
   a case prompt (real cases always have one).
3. Draft PR #264, Codex adversarial review, `om-auto-review-pr 264 --autofix` (COMMENT).

## Verification

- Red first: both new tests failed on the old code (`planText` lines lacked the warning; the
  fake-claude plan output had `Skill name: pdf-report` directly followed by `Baseline:   v1`).
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass. `pnpm test`: pass, 100% coverage
  (cli 210, agent-adapters 374, benchmark-engine 518, core 351, database 377, runner 312,
  web 608). `pnpm build`: pass. `pnpm verify:pack`: pass.
- Real CLI (`apps/cli/dist/cli.js`, data directory under `/var/tmp`, fake `claude` answering only
  `--version` and `auth status`; two nameless versions of slug `pdf` in folder `pdf-report`
  seeded with `importArtifactVersion`, since the CLI has no scan command): a suite with
  `/pdf write the report` printed
  `Warning:    case by-slug: the prompt starts with a / command other than /pdf-report (the installed skill name), so it does not invoke the skill.`
  right after `Skill name: pdf-report`; a suite with `/pdf-report …` printed no warning; with
  `--yes` the warned suite started its run (the fake fails every session, so it ended as
  `error`, exit 6), so the warning does not refuse.
- Codex adversarial review round 1 (`--scope branch --base main`): approve, no findings.
- `om-auto-review-pr 264 --autofix`: COMMENTED, approvable, one nit (lines unbounded by case
  count, like the Commands block). Nothing to autofix.
- Not verified: a real Claude Code session; the web suite page (out of scope); e2e and
  Storybook locally (CLI-only change; left to CI).

## Problems and deviations

- The fake `claude`'s recorded stream loads the skill as `pdf`, so a fake run of a skill
  installed as `pdf-report` stops after the first session (`artifact-not-loaded`); the
  integration test therefore asserts only that the run starts, like the existing issue 66 test.

## Lessons recorded

None: nothing non-obvious beyond the existing lessons.

## Follow-ups

- Non-blocking question of the issue: the web suite page could show the same note. It runs mock
  suites only today; out of scope here.
