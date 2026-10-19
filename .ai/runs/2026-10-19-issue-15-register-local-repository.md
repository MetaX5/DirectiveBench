---
title: Register a local repository by path and list repositories (issue #15, E01-S01)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 15 (feature route → om-auto-implement-spec → om-auto-create-pr)
status: in-progress
branch: feat/issue-15-register-local-repository
specs: [SPEC-104, SPEC-003, SPEC-006, SPEC-007, SPEC-014, SPEC-114]
---

# Run: Register a local repository by path and list repositories

Source doc: .ai/specs/2026-10-14-repository-management.md
Issue: #15

## Objective

Implement issue #15 (E01-S01): a skill author registers a local git repository or a plain
directory by path and sees it on the Repositories page. Acceptance criteria (from the issue):

1. A path inside a git work tree is stored as `local-git` with the top-level directory as
   location and its current branch shown (FR-104-03, FR-104-07).
2. A path not inside a git work tree is stored as `local-directory` (FR-104-03).
3. Registering an already registered path again (including `~` and trailing-slash variants)
   returns the existing repository; no duplicate row (FR-104-04).
4. A path that does not exist or is not a directory shows a field-level error and stores nothing.
5. No file, git config, index or hook in the registered repository is modified or executed; git
   runs with hooks and fsmonitor disabled (FR-104-11, FR-104-12).
6. The Repositories page lists name, provider, location, branch and artifact count instead of
   "Planned — not implemented" (FR-104-16).

## Plan

Goal: path registration flows web → job → runner, the runner resolves the path and inspects git
read-only, and the Repositories page lists the result.

Scope (smallest safe slice of SPEC-104):

- `core`: one shared Zod schema for the path field (non-empty, bounded, no NUL, absolute or
  `~`-prefixed) and `~` expansion.
- `database`: job type `repository-registration` with a strict payload schema; a nullable
  `jobs.result` JSON column (migration `0001`) where the runner records the outcome; an atomic
  insert-or-return-existing repository function; `listRepositories` with branch and active
  artifact count; the Executions list keeps showing benchmark jobs only.
- `runner`: canonicalise the path (`~`, trailing slash, symlinks via `realpath`), check it is an
  existing readable directory, then run hardened, read-only git (`rev-parse`, `symbolic-ref`)
  with the path as working directory (never in argv), an environment allowlist, hooks and
  fsmonitor disabled and optional locks off. `LocalRunner` dispatches the new job type.
- `web`: `registerRepositoryAction` (Zod-parsed, enqueue only, redirect); the Repositories page
  with the add form, the registration status (auto-refresh while the job is pending/running,
  field-level error on rejection) and the repository table.
- Specs: SPEC-104 gets an implementation plan for this slice and its data flow is changed to the
  runner job (resolves OQ-104-01 for local paths); SPEC-006 and SPEC-114 record the new job type
  and column.

Non-goals (issue scope): hosted URLs (#18), credentials, edit/disable/remove, connection
re-validation, branch picker, the scan itself (#16), `packages/git-providers`.

Risks: schema migration (additive nullable column — rollback plan in the PR); git executing
repository-controlled code (mitigated by the hardened invocation and proven by a malicious
fixture test); path canonicalisation mistakes (tests for `~`, trailing slash, symlink,
relative, missing, file, unreadable paths).

## Decisions

Recorded as the run progresses.

## Work performed

Recorded as the run progresses.

## Verification

Recorded at the end of the run.

## Problems and deviations

- SPEC-104 had no `## Implementation Plan`/`## Phasing` section, which `om-auto-implement-spec`
  requires, and its §9 data flow ran git in the web process (OQ-104-01 proposal), contradicting
  SPEC-003 §2.1/SPEC-014 §3.3 and the issue's implementation notes. Both are fixed in SPEC-104 in
  this PR rather than in a separate spec PR (the maintainer asked for that).

## Lessons recorded

Recorded at the end of the run.

## Follow-ups

Recorded at the end of the run.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Specs

- [x] 1.1 Update SPEC-104, SPEC-006 and SPEC-114 for the registration job — fde712c

### Phase 2: Persistence

- [x] 2.1 Shared path input schema and home expansion in core — 4bde9d0
- [x] 2.2 Registration job type, jobs.result column and migration — 65f47ba
- [x] 2.3 Insert-or-return repository and repository list with branch and artifact count — 65f47ba

### Phase 3: Runner

- [x] 3.1 Path canonicalisation and hardened read-only git inspection — 0399f13
- [x] 3.2 LocalRunner executes repository-registration jobs — d011219

### Phase 4: Web

- [ ] 4.1 registerRepositoryAction and registration status logic
- [ ] 4.2 Repositories page with add form, status and list
- [ ] 4.3 Playwright tests for the Repositories page

### Phase 5: Verification and wrap-up

- [ ] 5.1 Full validation gate and e2e
- [ ] 5.2 Real-app verification with a temporary data directory
- [ ] 5.3 Implementation status, lessons and run log
