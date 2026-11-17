---
title: Warn in the benchmark plan when a /<name> prompt no longer names the installed skill
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue #258 via om-auto-fix-issue (follow-up of issue 245, decision 7)
status: in-progress
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

(filled at the end)

## Verification

(filled at the end)

## Problems and deviations

## Lessons recorded

## Follow-ups

- Non-blocking question of the issue: the web suite page could show the same note. It runs mock
  suites only today; out of scope here.
