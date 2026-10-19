---
title: Scan a registered local repository for skills, instructions and rules (issue #16, E01-S02)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 16 (feature route → om-auto-implement-spec → om-auto-create-pr)
status: in-progress
branch: feat/issue-16-scan-local-repository
specs: [SPEC-102, SPEC-103, SPEC-104, SPEC-105, SPEC-114, SPEC-101, SPEC-003, SPEC-006, SPEC-007, SPEC-013, SPEC-014]
---

# Run: Scan a registered local repository

Source doc: .ai/specs/2026-10-14-artifact-discovery.md
Issue: #16

## Objective

Implement issue #16 (E01-S02): a scan, triggered from the UI and executed by the runner, records
every supported artifact of a registered local repository with its type, format and occurrence
path. Acceptance criteria (issue body as updated on 2026-10-19):

1. `.agents/skills/*/SKILL.md`, `AGENTS.md`, `.cursor/rules/*.mdc` and
   `.github/copilot-instructions.md` each become an artifact with the correct type, format and an
   occurrence path (SPEC-013 M1 AC1).
2. Every regular file under a directory-based skill is in the version's manifest (FR-102-12).
3. `.git/` and `node_modules/` are skipped, symlinks are not followed, a symlink at a candidate
   path is reported as a discovery error (FR-102-15, FR-102-18).
4. No discovered file is executed, imported or spawned; no git hooks, package scripts or LFS
   filters run (FR-102-19).
5. No path outside the registered repositories is read; user-level folders such as
   `~/.claude/skills` are never scanned implicitly (D05).
6. The same tree scanned twice gives identical artifacts, order, hashes and warnings (FR-102-20).
7. Content hashes are recomputed server-side; caller values are not trusted (FR-103-04).
8. A 1,000-file repository scan is measured and recorded in the PR (target < 5 s, M1 AC5).
9. Registering `/` is rejected; the home directory or a path that contains or is inside an
   already registered local repository needs a confirmation that explains scan size and double
   counting (SPEC-104 FR-104-18).

Out of scope (issue and coordinator): rescan/versioning rules (#19), cross-repository identity
(#20), removed files (#21), user-level folders (D05 opt-in), exclude-glob settings UI, hosted
repositories (#18), OQ-104-05 (same directory under two providers, deferred to #19/#20).

## Plan

Goal: "Scan" on a registered local repository enqueues a `repository-scan` job; the runner walks
the registered directory with the existing `discoverArtifacts`, stores every discovered artifact
through the `importArtifactVersion` code path (hashes recomputed) in one transaction and records a
summary with the discovery errors in `jobs.result`; the Repositories page shows the outcome.
Registration rejects `/` and asks for confirmation on broad or overlapping paths.

### Design

- **Scan flow.** Web `scanRepositoryAction({ repositoryId })` (Zod) → `enqueueRepositoryScanJob`
  (repository must exist and be `local-git`/`local-directory`; at most one pending/running scan
  per repository, FR-105-03, check-then-insert inside `withTransaction`) → runner
  `scanLocalRepository`: re-checks that `realpath(location) === location` and that it is a
  readable directory (a registered location that became a symlink or moved fails closed —
  nothing outside the registered path is read), runs `discoverArtifacts(location, { signal })`,
  honours cancellation before the apply step (FR-105-17), then `applyRepositoryScan` writes all
  artifacts and the repository's `last_sync_at`/`sync_status`/`sync_error` in one transaction
  (FR-105-09 subset). Result `{ ok, scannedFiles, discovered, createdArtifacts, createdVersions,
  errorCount, errors[≤ 100], warningCount, durationMs }` or `{ ok: false, code, message }`.
- **Working tree, not a commit.** Both local providers scan the files on disk (including
  uncommitted and untracked files); no git command runs during a scan, so no hook, filter or
  fsmonitor can run. Occurrences and versions record `commit_sha = null`; the UI says "working
  tree" and does not attribute the scan to the branch stored at registration. This matches
  SPEC-013 (M1: scan of local directories; M2: local git awareness — commit SHA, branch, dirty
  state). It deviates from FR-102-15 (second sentence) and FR-105-05/06 for `local-git` (read
  the committed tree from the object store); recorded in SPEC-102/104/105 and as a decision for
  the maintainer (OQ-104-02).
- **Identity: never merge by slug for repository content.** `importArtifactVersion` matches the
  logical artifact by slug (bootstrap). For a scan that would merge every repository's
  `AGENTS.md` into one artifact and could attach a repository skill to the bundled demo skill.
  The scan uses SPEC-101 §8.3 rule 1 (same repository + path → same artifact) and rule 4
  (otherwise a new artifact, slug suffixed `-2`, `-3`… on collision, FR-105-16 c). Rules 2–3
  (moves, exact copies across repositories) stay with #20. Implemented as an `identity` option of
  the shared version writer; bundled-example import keeps slug matching.
- **FR-104-18 round trip.** Only the runner knows the canonical location, so the decision happens
  there, atomically with the insert (`registerLocalRepository` runs check + insert in one
  `withTransaction`): `/` or a drive root (`parse(p).root === p`) → `{ ok: false, code:
  'filesystem-root' }`; an existing repository with the same provider and location → returned as
  before (no confirmation); the home directory (or an ancestor of it) or a strict ancestor /
  descendant of a registered `local-git`/`local-directory` location → `{ ok: false, code:
  'confirmation-required', location, home, overlaps[] }` unless the job payload carries
  `confirmedLocation` equal to the canonical location. The page renders the explanation (scan
  size; same files counted as occurrences in both repositories; for the home directory also that
  user-level folders such as `~/.claude/skills` would be scanned) with **Register anyway**
  (re-submits the same path plus `confirmedLocation`) and **Cancel**. Binding the confirmation to
  the canonical location means a path that resolves elsewhere by the time it is confirmed asks
  again. Exact same location under another provider is not an overlap (OQ-104-05 unchanged).
- **OQ-104-06 runner slot.** A separate short-job lane: the runner keeps `runner.concurrency`
  slots for long jobs (`benchmark-run`, `repository-scan`) and one extra slot for
  `repository-registration`, using `acquireNextJob(db, runnerId, types)`. Scans count as long
  jobs (unbounded by tree size). Flagged as "⚠️ Decision needed".

### Non-goals

Rescan semantics beyond rule 1 dedup, marking missing occurrences, move detection, exact-copy
linking, exclude globs, user-level folders, hosted repositories, sync history tables
(`sync_runs`), tracked-files-only filtering for `local-git`.

### Risks

Untrusted content reaching the database (mitigated: reuse of the bounded walker, hashes
recomputed, Zod at boundaries, single transaction); path escapes (canonical-location re-check,
symlink tests); a long scan blocking shutdown (signal checks in the walker); data integrity of
identity (rule 1/4 only, tests for cross-repository and bundled-example collisions).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Core

- [x] 1.1 Path relation helpers (filesystem root, same/inside) in core — f9f09be
- [x] 1.2 Cancellation signal for discoverArtifacts — 8876f60, d6da2f0

### Phase 2: Database

- [x] 2.1 Registration payload confirmation, root and confirmation results, atomic overlap check — 7c1f888
- [x] 2.2 Typed job acquisition and repository-scan job type with enqueue dedupe and read model — 7c1f888
- [x] 2.3 Shared version writer with location identity and applyRepositoryScan — 17c7e78, 7c1f888

### Phase 3: Runner

- [x] 3.1 Registration rejects the filesystem root and asks for confirmation — ff65d91
- [x] 3.2 scanLocalRepository job handler — ff65d91
- [x] 3.3 Short-job lane and repository-scan dispatch in LocalRunner — ff65d91

### Phase 4: Web

- [x] 4.1 Server actions for scan and confirmed registration — 18692a1
- [x] 4.2 Repositories page: confirmation panel, scan button, scan status and errors — 18692a1
- [x] 4.3 Playwright tests for scan and FR-104-18 — 18692a1

### Phase 5: Specs, verification and wrap-up

- [x] 5.1 Spec updates (SPEC-102 phasing, SPEC-104, SPEC-105, SPEC-114, SPEC-101, SPEC-103, SPEC-006) — 8067aa6
- [x] 5.2 Full gate, performance measurement and real-app verification — f6f3fa0
- [ ] 5.3 Run log, lessons and PR finalisation

## Decisions

- **Plan review before code.** A sceptical plan reviewer (subagent) returned 2 blockers and
  7 majors on the plan above; all were addressed or recorded before implementation went further:
  - *Interleaved writes on the shared connection* (blocker): fixed generically in
    `withTransaction` (statements from outside the open transaction wait, `AsyncLocalStorage`);
    `finishJob` guarded against overwriting terminal states; the apply transaction re-checks that
    the job is still running and not cancelled.
  - *One unbounded transaction* (blocker): kept one transaction for FR-105-09 atomicity and
    measured the worst case instead (10,000 changed artifacts hold the write lock ≈ 2.4 s, under
    the 5 s `busy_timeout`); NFR-105-03 recorded as not met in that case, batching is a follow-up.
  - Root rows from #15 are refused at scan time; bundled-example identity can no longer attach to
    a scanned artifact (and vice versa); unreadable subdirectories become `read-failed` errors;
    skill files are grouped in one pass; `expectedRoot` pins the scan root in discovery's own
    `realpath`; the residual intermediate-directory swap risk is documented (SPEC-102 §14).
- **Working tree for `local-git` (interim, needs maintainer confirmation).** SPEC-013 places local
  git awareness (commit SHA, branch, dirty state) in M2; the M1 scan reads files on disk for both
  local providers, runs no git and records no commit. Recorded in SPEC-102 Phasing/§20, SPEC-104
  OQ-104-02, SPEC-105 §20. Known noise: git-ignored folders (`dist`, `.venv`, nested worktrees)
  are scanned too.
- **Identity: rule 1 + rule 4, no slug merging for repository content.** Slug matching would merge
  every repository's `AGENTS.md` into one artifact and could attach repository skills to the
  bundled demo skill. Rules 2–3 stay with #20.
- **FR-104-18 round trip bound to the canonical location**, decided atomically with the insert in
  the database layer; same location under the other provider is not an overlap (OQ-104-05
  unchanged); an ancestor of the home directory is treated like the home directory.
- **OQ-104-06 (needs maintainer confirmation):** one extra runner slot for registrations; scans are
  long jobs. SPEC-114 FR-114-11 amended.
- **No migration**: `jobs.type` has no CHECK constraint, `repository-scan` needs no DDL.
- **Scan result in `jobs.result`**, not `sync_runs` (not needed for this story).

## Work performed

1. Core: path helpers, location schema, walker signal, unreadable directories, `expectedRoot`
   (f9f09be, 8876f60, d6da2f0).
2. Database: shared-connection isolation (17c7e78); scan jobs, scan apply, FR-104-18 checks,
   typed acquisition, guarded finish (7c1f888).
3. Runner: scan handler, registration checks, short-job lane, `runUntilIdle` fix (ff65d91).
4. Web: scan action, confirmation panel, scan status, Playwright tests (18692a1).
5. Specs and README (8067aa6), lessons (f6f3fa0).

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify:pack`
  — all exit 0 on 2026-10-19; 633 unit/integration tests (core 137, database 100, runner 88,
  web 89, cli 75, benchmark-engine 110, agent-adapters 34), 100% coverage in every package.
- `pnpm test:e2e` — 26 passed (4 new: scan + rescan, `/` rejected, overlap confirmation with
  Cancel and Register anyway, home confirmation).
- risk-high evidence: `packages/runner/test/repository-scan.test.ts` — a git repository with
  hooks, fsmonitor, filter driver, package script and executable skill script leaves no marker
  and no `child_process` function is called during the scan; symlinks out of the repository are
  not followed; a sibling directory and a `HOME` with `~/.claude/skills` are not read; a location
  replaced by a symlink is refused; the same tree scanned twice gives identical discovery output
  and creates nothing new; FR-104-18 rejected and confirm-required paths in
  `packages/runner/test/repository-registration.test.ts` and `packages/database/test/catalog.test.ts`.
- Real app (built CLI, temporary data directory, browser): a local clone of this repository plus
  a Cursor rule → 673 files, 47 artifacts in 129 ms; a 1,000-file directory → 50 artifacts in
  56 ms, rescan 0 new; a 50,000-file directory → 200 artifacts in 207 ms; `/` rejected; a
  directory inside a registered one → confirmation naming it, then registered after "Register
  anyway"; `~` → home-directory confirmation, cancelled. Worst case 10,000 changed artifacts:
  3.3 s scan, write lock held ≈ 2.4 s (probe from a second connection).
- Not verified: macOS and Windows (drive-root and case-insensitive paths), a confirmed scan of a
  real home directory, cancellation of a real long scan from the UI (runner-level cancellation is
  tested), the page while no runner is running.

## Problems and deviations

- The plan's single-lane assumptions broke `runUntilIdle` (a fast job finished while `poll` filled
  the second lane and was lost); fixed by collecting results as jobs finish.
- Same-millisecond `created_at` makes FIFO order fall back to random ids; the lane test uses
  distinct times.
- Suffixed slugs broke bundled-example re-identification across installs; fixed with a name/type
  match within the provider (lesson).
- Deviations recorded in specs: FR-102-15 second sentence and FR-105-05/06 for `local-git`
  (working tree); NFR-105-03 in the worst case; job type named `repository-scan`.

## Lessons recorded

- [Shared-connection transactions](../lessons/2026-10-19-shared-connection-transactions.md)
- [Suffixed slugs break slug lookups](../lessons/2026-10-19-suffixed-slugs-break-slug-lookups.md)

## Follow-ups

- Batch very large scan applies (NFR-105-03), or confirm the single transaction.
- Exclude globs / tracked-files filter for noisy working trees (FR-104-13, M2 local git awareness).
- Rescan rules (#19), cross-repository identity (#20), removed files (#21), hosted repositories (#18).
