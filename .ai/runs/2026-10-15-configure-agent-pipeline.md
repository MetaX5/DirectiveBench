---
title: Configure the om-* agent PR pipeline
date: 2026-10-15
agent: Claude Code / claude-opus-5-5
trigger: user request (/om-setup-agent-pipeline)
status: completed
branch: chore/configure-agent-pipeline
specs: [SPEC-014, SPEC-009, SPEC-006, SPEC-008, SPEC-108, SPEC-115, SPEC-010]
---

# Run: Configure the om-\* agent PR pipeline

## Objective

Run `om-setup-agent-pipeline`: write `.ai/agentic.config.json`, install the tracker and browser
descriptors, create the missing GitHub labels and generate the missing project docs (`SDLC.md`,
`CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`), derived from this repository.

## Plan

Detect → ask the user → draft in a scratchpad → show the drafts → write, create labels, check
coverage → quality gate → commit and open a PR.

## Decisions

All choices were confirmed by the user in the setup interview:

- Tracker `github` (origin is github.com, `gh` authenticated); browser provider `agent-browser`.
- Validation gate mirrors CI except E2E and the audit: `pnpm format:check`, `lint`, `typecheck`,
  `test`, `build`, `verify:pack`. `pnpm test:e2e` stays the conditional UI gate from `AGENTS.md`
  (documented in `SDLC.md`).
- Full label taxonomy, QA gate on.
- `reviewChecklist` points at SPEC-014 (§10 is the review checklist). `CODE_REVIEW.md` links it
  instead of copying it, so the rules have one home.
- `AGENTS.md` / `CLAUDE.md` already exist and were left untouched. `SDLC.md` defers to `AGENTS.md`
  for the `.ai/` obligations.
- New branch from `origin/main`: PR #5 for the previous branch was already merged.

## Work performed

1. Installed `.ai/agentic.config.json`, `.ai/trackers/github.md`, `.ai/browsers/agent-browser.md`
   (copied from the skill's shipped references), `.gitkeep` in `.ai/{runs,analysis,specs,scripts,qa}`.
2. Added `.ai/qa/artifacts_*/`, `.ai/qa/test-env.json` and `.ai/qa/test-env.env` to `.gitignore`.
3. Generated `SDLC.md` from the skill template (no discovery layer), `CODE_REVIEW.md` and
   `BACKWARD_COMPATIBILITY.md` from an inventory of the CLI, config, benchmark format, migrations,
   job payloads, data-directory layout and `/api/health`.
4. Created 25 missing labels on `MetaX5/DirectiveBench`; `bug` and `documentation` already
   existed and were not modified.

## Verification

- `pnpm format:check` — pass (`.ai/` and `*.md` are in `.prettierignore`).
- `pnpm lint && pnpm typecheck && pnpm test` — pass (7/7 turbo tasks; all test files passed).
- Cross-skill coverage check from the skill — `SKILL_COVERAGE_OK`.
- Every relative link in the three generated docs resolves; the config parses, and its tracker,
  browser and review-checklist paths exist.
- Label list after creation: 35 labels, including all 27 from the taxonomy.
- Not verified: `pnpm build` / `pnpm verify:pack` (no app, packaging or dependency change);
  `agent-browser` provisioning (no QA run yet); any pipeline skill end to end.

## Problems and deviations

- Local `gh` is 2.46.0, below the tracker descriptor's minimum of 2.82.1. Label writes use REST
  and worked; `gh pr view` / `gh issue view` without `--json` may fail until `gh` is upgraded.
- The untracked `.ai/docs/` directory (holding `2026-09-01-engineering-standards.md`, the
  external source document of SPEC-014) was found empty at 12:37 during the run. No command in
  this run touched that path; not investigated further.

## Lessons recorded

None. No non-obvious bug or correction.

## Follow-ups

- Maintainer: decide the version-bump policy for `directivebench` (TODO in
  `BACKWARD_COMPATIBILITY.md`), and review the proposed one-release deprecation window for CLI
  names.
- If SPEC-014 moves to `.ai/specs/implemented/`, update `reviewChecklist` in the config.
- Upgrade `gh` to ≥ 2.82.1.
