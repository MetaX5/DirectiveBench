---
title: Register a local repository by path and list repositories (issue #15, E01-S01)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 15 (feature route → om-auto-implement-spec → om-auto-create-pr)
status: completed
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

- **Registration is a runner job, not a web-side git call.** SPEC-104 §9 had git running in the
  Server Action (OQ-104-01 proposal); that contradicts SPEC-003 §2.1 / SPEC-014 §3.3 and the
  issue's implementation notes. The action validates and enqueues `repository-registration`; the
  runner resolves the path and runs git. SPEC-104 §9/§18 updated (OQ-104-01 resolved for local
  paths only; hosted validation stays open for #18).
- **Nullable `jobs.result` column (migration `0001`).** The page must name the new or existing
  repository and show a typed rejection; `jobs` had no output column and overloading `payload` or
  `error` would mix input and output. Additive and nullable, so older code ignores it; rollback is
  `ALTER TABLE jobs DROP COLUMN result` (rehearsed in `client.test.ts`). No other open PR has a
  migration (checked with `gh pr list`).
- **A rejected path is a `completed` job with `result.ok = false`**, not `failed` — FR-114-10 says
  outcomes never make a job fail; `failed` stays for unexpected errors (e.g. invalid payload).
- **Git is asked questions whose answers carry no user data.** The path is the working directory
  (never an argument, so no option injection), the top level comes from `--show-cdup`, because
  `runCommand` redacts stdout and a token-like directory name would otherwise be stored as
  `[REDACTED]` (lesson recorded).
- **Fail closed:** git missing → `git-not-installed` (a plain directory is not registered either,
  since we cannot tell whether it is a work tree); a path inside `.git` or a bare repository →
  `git-directory` instead of registering git internals as a folder; any git error other than "not a
  git repository" → `git-failed`; unclassified `realpath` errors fail the job.
- **`HOME`/`XDG_CONFIG_HOME` are forwarded to git** so the user's global config (`safe.directory`)
  applies; command-line `-c` values override any `core.fsmonitor`/`core.hooksPath` from it or from
  the repository.
- **Re-registering returns the existing row unchanged** (FR-104-04); the stored branch is not
  refreshed — re-validation is FR-104-10's on-demand check, out of scope.
- **The Executions list shows benchmark jobs only** (`listJobs` filters `benchmark-run`), because
  its columns are benchmark-specific; registration jobs are visible on the Repositories page.
- **UX while the job runs:** the action redirects to `/repositories?registration=<jobId>`; the page
  says "Waiting for the runner…" (pending) or "Checking … (read-only)…" (running), disables the
  field and refreshes every 2 s (`AutoRefresh`); on completion it confirms "Registered …" or
  "… is already registered", or shows the rejection under the field with the path pre-filled.
  Syntax errors (empty, relative, `~user`) are caught by the action before any job exists.
- **Scope:** the nav "planned" marker is removed from Repositories; the page carries a
  "Planned — not implemented: scanning, hosted URLs" badge (AGENTS.md §7).

## Work performed

1. Specs: SPEC-104 Phasing section, §9 data flow, error codes, OQ-104-01; SPEC-006 and SPEC-114
   job type and column — `fde712c`.
2. `core`: `repositoryPathInputSchema`, `expandHomePath` — `4bde9d0`.
3. `database`: job type, payload/result schemas, `enqueueRepositoryRegistrationJob`,
   `getRepositoryRegistration`, `finishJob(…, result)`, migration `0001_add_job_result`,
   `registerLocalRepository`, `listRepositories` artifact count, `listJobs` filter — `65f47ba`.
4. `runner`: `inspectLocalPath`/`registerLocalPath` with hardened git — `0399f13`; `LocalRunner`
   dispatch, cancellation and shutdown — `d011219`.
5. `web`: `registerRepositoryAction`, `describeRegistration`/`branchLabel`/`providerLabel` —
   `dac91e6`; Repositories page and nav — `8af4224`; Playwright tests — `54b99bb`; status copy
   polish after the manual run — `26ad21d`.
6. Spec implementation status, lesson and this log — see the final commits of the PR.

## Verification

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm verify:pack`: all exit 0
  ("Packaging verification passed").
- `pnpm test`: exit 0, 100% statements/branches/functions/lines in every package — after the
  review fixes: cli 75, agent-adapters 34, benchmark-engine 110, core 125, database 76, web 78,
  runner 67 tests (final run at `19d9999`; build and verify:pack also re-run there). The runner test files were run 3–5 times in a row without a failure.
- `pnpm test:e2e`: 22 passed (before the review, after the review fixes, and at `19d9999`),
  including the 5 new tests in `e2e/repositories.spec.ts`.
- Real app: built CLI, `init` + `serve --port 4431` on a temporary data directory, driven with
  headless Chromium. Registered a nested path with trailing slash inside a new git repo on branch
  `develop` → `my-skills`, Local Git, top level, `develop`; a plain folder → Local directory, `—`;
  `~/projekty/DirectiveBench` → Local Git at `/home/mateusz/projekty/DirectiveBench`, `main`; the
  repo again via `my-skills/` → "already registered" (same repository id in `jobs.result`); a
  missing path → field error, nothing stored; `relative/path` → field error, no job. The top-level
  files of the registered primary repository's `.git` (including `index`) had identical mtimes and
  sizes before and after.
- Not verified: macOS/Windows (CI is Linux only; `/dev/null` for `core.hooksPath` on Git for
  Windows and case-insensitive duplicates are untested); git older than 2.53 locally (CI uses the
  runner image's git); registration while the runner is not running (the page keeps saying
  "Waiting for the runner" — by design, not exercised).

## Problems and deviations

- Review (own `om-code-review` pass and an independent reviewer subagent) found, all fixed in this
  PR with regression tests:
  - BLOCKER: a bare `git` spawned with the repository as `cwd` could run a `git` committed in the
    repository (empty/`.` `PATH` entries; Windows looks in the cwd first). Git is now located on
    absolute `PATH` entries and spawned by absolute path; relative entries are removed — `10fcc70`.
  - MAJOR: `core.worktree` could make `--show-cdup` point at `/`; the top level must now be the
    nearest directory holding a `.git` entry — `10fcc70`.
  - MINOR: broken `.git` file treated as a plain directory; redacted branch stored; raw `ZodError`
    shown; spawn errors reported as "git not installed"; 5 s kill grace on a timed-out git — `10fcc70`.
    The field error was reflected from the URL — `701249c`; the echoed path was uncapped —
    `fcf1de0`; the rollback rehearsal did not remove the migration row — `feb6f22`; NFR-104-01 was
    over-claimed (now partial, incl. queueing behind benchmarks) and the "hooks armed" claim was not
    asserted (now asserted) — `9428d9d`.
  - Re-review by the same independent reviewer at `71ce332`: APPROVE (all 13 findings verified
    fixed, including re-run reproductions). Its two optional follow-ups — Windows should look only for
    `git.exe`/`git.com` (Node refuses `.cmd`/`.bat` without a shell) and a neutral message for a
    top-level mismatch — were fixed in `19d9999`.

- SPEC-104 had no `## Implementation Plan`/`## Phasing` section, which `om-auto-implement-spec`
  requires, and its §9 data flow ran git in the web process (OQ-104-01 proposal), contradicting
  SPEC-003 §2.1/SPEC-014 §3.3 and the issue's implementation notes. Both are fixed in SPEC-104 in
  this PR rather than in a separate spec PR (the maintainer asked for that).

## Lessons recorded

- [Never store a value parsed from redacted command output; inspect git with the path as cwd and
  `--show-cdup`](../lessons/2026-10-19-derive-git-paths-from-cwd-not-redacted-output.md).
- Repeated an existing lesson: `pkill -f "port 4431"` killed the agent's own shell while stopping
  the manual-test server (lesson 2026-10-14 "testing processes": kill by PID). No new lesson.

## Follow-ups

- #16 (scan) consumes `repositories.location`/`default_branch` written here.
- FR-104-16 columns still missing: last sync time, sync status, credential source.
- On-demand re-validation (FR-104-10) and refreshing a stale branch on re-registration.
- A branch name that looks like a token is stored redacted (it comes from redacted git output);
  harmless for display, but sync (#16) should read the branch again rather than trust it blindly.
- Explicit "register this work tree as a local directory" option (FR-104-03).

## Progress

PR: #42

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

- [x] 4.1 registerRepositoryAction and registration status logic — dac91e6
- [x] 4.2 Repositories page with add form, status and list — 8af4224
- [x] 4.3 Playwright tests for the Repositories page — 54b99bb

### Phase 5: Verification and wrap-up

- [x] 5.1 Full validation gate and e2e — 9428d9d
- [x] 5.2 Real-app verification with a temporary data directory — 26ad21d
- [x] 5.3 Implementation status, lessons and run log — 9fa0934
