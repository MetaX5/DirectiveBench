---
title: Install a nameless skill under its folder name (issue 245)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue 245, maintainer decision 2026-11-17 (option C)
status: completed
branch: fix/issue-245-nameless-skill-install-name
specs: [SPEC-203, SPEC-118, SPEC-103, SPEC-107, SPEC-108]
---

# Run: Install a nameless skill under its folder name (issue 245)

## Objective

A skill without a frontmatter `name` is installed by the Claude Code adapter (and the mock agent)
under the folder its repository's agent sees, not under the immutable slug. Acceptance criteria:
the rule is in SPEC-203; adapter tests cover a renamed nameless skill and a collision; 100%
coverage; mock agent only.

## Plan

1. Decision material (`.ai/tmp/issue-245-decisions.md`), maintainer picked option C with answers
   1-8 (see Decisions).
2. Spec first: SPEC-203 §4.1 and AC-5, SPEC-118 FR-118-04/08/31 and §8, SPEC-103 §14 case 9 and
   the `ArtifactBundle` interface, SPEC-107/SPEC-108 mock convention.
3. `ArtifactBundle.folderName?` in core; a new database loader `getInstallableArtifactBundle` in a
   new repository file (`artifacts.ts` is owned by the parallel issue 239 run); runner and CLI use it.
4. Adapter: name = frontmatter `name` ?? folder ?? slug; directory = slug when named, else the
   name; mock agent the same; `installedSkillName` in the run metadata; plan line.
5. Red-first tests, gate, real run with the built CLI and the mock agent, follow-up issues, Codex
   review, `om-auto-review-pr`.

## Decisions

- Maintainer, 2026-11-17: option C; invalid folder names refused with `skill-name-unsupported`;
  skills with a frontmatter `name` keep the slug directory; collisions with CLI-listed names and a
  plan-time `/<slug>` warning are follow-up issues; the run-time name is recorded in the metadata
  and shown in the plan; the mock agent follows the rule; one skill per workspace is written into
  SPEC-203 §4.1, collision suffixes deferred. No ADR (an adapter fidelity rule recorded in the spec).

## Work performed

1. `8ef592b` docs(specs): the skill-name rule in SPEC-203 §4.1 and AC-5, SPEC-118
   FR-118-04/08/31 and §8, SPEC-103 §14 case 9 and the `ArtifactBundle` interface, and the
   SPEC-107/SPEC-108 mock convention.
2. `335e9e4` test: red-first adapter, mock, database and CLI tests.
3. `a0baef2` fix: `ArtifactBundle.folderName?` (core); `getInstallableArtifactBundle` in a new
   `packages/database/src/repositories/artifact-bundles.ts`; `claudeSkillInstall` (name and
   directory), install under it, `installedSkillName` in the run metadata; `mockSkillDirectory`;
   the runner and the CLI plan load bundles through the new loader; plan line `Skill name:`.
4. Follow-up issues #257 (names Claude Code lists itself) and #258 (plan warning for `/<slug>`
   prompts), filed with `om-prepare-issue`.

## Verification

- Red first: on the stashed source, 8 of the new adapter and mock tests failed. For example,
  `runs a renamed nameless skill …` failed with `expected [ '.claude/skills/pdf/SKILL.md' ] to
  deeply equal [ '.claude/skills/code-review/SKILL.md' ]`. All pass with the fix.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (7/7): pass.
- `pnpm test`: all 7 packages pass with 100% coverage (agent-adapters 374 + 2 skipped,
  database 369, cli 208, runner 307, engine 518, core 351, web 605).
- `pnpm build` and `pnpm verify:pack`: pass ("Packaging verification passed").
- `pnpm test:e2e` (port 4401): 191 passed. `pnpm test:storybook`: 68 files, 342 tests passed.
- Real run with the built CLI, data directory `/var/tmp/issue-245-run`, mock agent only:
  - `init` and `demo`, then `serve --port 4404`.
  - Registered a local repository with a nameless copy of the demo skill at
    `.agents/skills/input-guard` and scanned it (Playwright on the real app).
  - Renamed the folder to `input-validator` and rescanned: "1 moved". The slug stays
    `input-guard`, the name becomes `input-validator`, the version's `source_path` is still
    `.agents/skills/input-guard`.
  - Assigned the demo suite and ran it from the suite page. The run completed `improved`; the
    candidate trace shows `Installed artifact files: .agents/skills/input-validator/SKILL.md`.
  - `benchmark init` and `benchmark run` with a fake `claude` (version and auth status only,
    no session) printed `Candidate:  input-guard (named input-validator) v1` and
    `Skill name: input-validator`, then stopped at the confirmation.
- Not verified:
  - A real Claude Code session with a folder-named skill (no paid or authenticated runs).
  - Which skill wins when a name collides with one the CLI lists itself (#257).

- Codex adversarial review (`--scope branch --base main`):
  - Round 1, needs-attention: a rename rescanned between plan confirmation and the runner's load
    changes the name. This is the risk the maintainer accepted with decision 5. It is now
    documented in SPEC-203 §4.1 (`0c9b0ca`).
  - Round 2: approve.
- `om-auto-review-pr 256 --autofix`: submitted as a COMMENT. Approvable, with two minors (the
  repeated ordering and the documented residual). Nothing to autofix.

## Problems and deviations

- `packages/database/src/repositories/artifacts.ts` belongs to the parallel issue 239 run, so the
  loader lives in a new file and repeats the `refreshSourceFields` occurrence ordering instead
  of sharing it. `ArtifactBundle.folderName` is optional because `getArtifactBundle` (in that
  file) is typed `ArtifactBundle`. Absent means the slug.
- Test-writing surprises (recorded in the lesson):
  - An empty complete scan keeps every occurrence.
  - Nameless copies in differently named folders do not link.
- The adapter test for the run metadata first failed with `workspace-contains-claude-config`,
  because the request did not list the installed paths. The test now passes them, as the
  engine does.

## Lessons recorded

- [2026-11-17 A version's source_path is where it was created, not where the artifact is now](../lessons/2026-11-17-a-version-source-path-is-its-creation-path.md)

## Follow-ups

- #257 detect a skill name that collides with a name Claude Code lists itself.
- #258 plan-time warning for `/<slug>` prompts.
- After issue 239 merges: consider moving the folder resolution into `getArtifactBundle`,
  sharing the `refreshSourceFields` ordering, and making `folderName` required.
