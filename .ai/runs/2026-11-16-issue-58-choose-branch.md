---
title: Hosted repositories, choose the branch to scan (issue 58)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: issue 58, decisions B1-B11 approved by the maintainer on 2026-11-16 (issue comment)
status: in-progress
branch: feat/issue-58-choose-branch
specs: [SPEC-104, SPEC-105, SPEC-103, SPEC-125, SPEC-014, database schema]
---

# Run: Hosted repositories, choose the branch to scan (issue 58)

## Objective

Let the user choose the branch a public GitHub repository is scanned on, at registration and
later on its row, following the approved decisions B1-B11 (issue 58 comment of 2026-11-16) with
the two maintainer corrections: the "branch does not exist" error sits directly under the Branch
field (`aria-describedby`/`aria-invalid`) at registration and in the change panel, and the Branch
field has no placeholder. Acceptance criteria of the issue: the branch is validated as a safe
name and checked against the remote (`ls-remote`) in the runner only; a changed branch is
fetched into the cache per SPEC-105 FR-105-05 without mixing the old snapshot in; unit and
Playwright tests without network.

## Plan

### Core (`packages/core`)

1. Move `isSafeBranchName` from `packages/runner/src/hosted-git.ts` to core (re-exported where
   the runner used it) and add `branchNameSchema`: a string, trimmed, empty string maps to
   `null` ("follow the default"), otherwise at most 255 characters and `isSafeBranchName`; one
   fixed message naming the allowed characters (B3/Q5):
   'A branch name may use letters, digits, ".", "_", "-" and "/". It cannot start with "-" or
   ".", contain ".." or a space, or end with ".lock".'

### Database (`packages/database`)

2. Migration `0008_repository_scanned_branch.sql`: `ALTER TABLE repositories ADD scanned_branch
   text` (nullable, no backfill). Schema column `scannedBranch`. Migration test: up on a 0007
   database keeps rows (null), down (drop column + forget) and re-apply.
3. `JOB_TYPES` gains `repository-branch` (no SQL change: `jobs.type` has no CHECK).
4. Payload/result schemas:
   - `repositoryRegistrationPayloadSchema` URL variant gains optional `branch` (non-null safe
     name; an empty field is simply omitted).
   - `repositoryBranchPayloadSchema = { repositoryId, branch: safe name | null }` strict.
   - `repositoryBranchResultSchema = { ok: true, branch: string | null, defaultBranch: string |
     null } | { ok: false, code: 'branch-not-found' | 'repository-not-found' |
     'unsupported-provider' | 'scan-active' | hosted git failure codes, message }`.
   - Scan success result gains optional `branch` (hosted scans; absent for local and old
     results). `REPOSITORY_SCAN_ERROR_CODES` gains `branch-changed`.
5. `enqueueRepositoryBranchJob(handle, payload)`: one transaction; `NotFoundError` for a
   missing repository, `UnsupportedRepositoryError` for a non-hosted one, a typed refusal
   (`scan-active`) when a `repository-scan` of that repository is pending or running; returns
   the branch job already pending or running for the repository instead of a second one
   (same pattern as `enqueueRepositoryScanJob`).
6. `setRepositoryBranch(db, { repositoryId, branch, defaultBranch })`: one conditional UPDATE
   (`selected_branch`, `default_branch = coalesce(new, old)`, `updated_at`) guarded by
   `NOT EXISTS` a pending/running `repository-scan` job naming the repository; stores null when
   `branch` equals the detected default (B4/OQ-1). Returns `updated | scan-active | not-found`
   (a second read after a no-op update tells the two apart, inside one transaction).
7. `registerHostedRepository` gains `selectedBranch` for a new row only (insert); the conflict
   branch never changes `selected_branch` (a re-registration is not a branch change; see
   Decisions). `getRepositoryRegistration` exposes the payload's `branch`.
8. `applyRepositoryScan` / `recordUnchangedRepositoryScan` take `branch: string | null`; for a
   hosted scan the transaction re-checks `coalesce(selected_branch, default_branch) = branch`
   and otherwise throws `BranchChangedError` (nothing applied); the success UPDATE writes
   `scanned_branch = branch` together with `last_commit_sha`. Local scans pass null and write
   `scanned_branch = null`.
9. `getRepositoryBranchChange(db, jobId)` reader for the page (validated payload/result and the
   repository row), like `getRepositoryRegistration`.

### Runner (`packages/runner`)

10. `hosted-git.ts`: `checkRemoteBranch(context, location, branch | null)` runs ONE
    `ls-remote --symref -- <url> HEAD [refs/heads/<b>]` (same hardened invocation, `lsRemote`
    timeout, bounded output) returning `{ defaultBranch, exists }` with exact ref matching
    (`detectDefaultBranch` becomes the `branch = null` case). `fetchSnapshot`: when the cache
    exists, `for-each-ref --format=%(refname) refs/` (local step, `GIT_DIR` = cache); unless it
    lists exactly `refs/heads/<b>`, the cache is deleted and cloned fresh (FR-105-05: the old
    snapshot is never mixed in; self-healing after a crash).
11. Registration of a URL with `branch`: one `ls-remote`; missing branch -> `branch-not-found`
    "The branch X does not exist in owner/repo. Check the name on GitHub, or leave Branch empty
    to use the default branch." and nothing stored; otherwise store `selected_branch` (null when
    equal to the default).
12. New `changeHostedBranch(handle, payload, options)` for the `repository-branch` job (short
    lane, `UNEXPECTED_JOB_FAILURE` entry): load the repository (missing ->
    `repository-not-found`, not hosted -> `unsupported-provider`), one `ls-remote`, missing
    branch -> "The branch X does not exist in owner/repo. Nothing was changed: the repository
    still uses <current>.", else `setRepositoryBranch` (refused -> `scan-active`).
13. `hostedScanConfigHash(appVersion, branch)` includes the branch; scans pass the effective
    branch to the store/unchanged calls; `BranchChangedError` -> `branch-changed` "The branch
    changed during the scan. Scan again." (recorded like other store failures); a
    `branch-not-found` scan failure of a chosen branch says "The branch X does not exist in the
    repository any more. Change the branch, or leave it empty to use the default branch."; the
    result records `branch`.

### Web (`apps/web`)

14. Register form: "Branch (optional)" field (no placeholder; help "GitHub only. Empty: the
    default branch."); action validates path/URL first, then the branch with
    `branchNameSchema`; a branch with a local path -> Branch field error "A local repository is
    scanned from its working tree; leave Branch empty."; invalid name -> Branch field error;
    redirects `?path=&branchName=&branchError=invalid|local` (values echoed only when
    `mayCarryCredentials` is false). Registration notices gain a `field: 'path' | 'branch'`;
    `branch-not-found` shows under the Branch field with path and branch kept. Pending copy
    names the branch.
15. Row: "Change branch" (`outline sm`, accessible name "Change branch of <subject>") for
    hosted rows, GET `?changeBranch=<id>#branch-panel` opening the panel above the table (focus
    target `#branch-panel` like `#remove-panel`; the field autofocuses after an error). Panel:
    heading, Branch field (no placeholder) + help "Leave empty to follow the default branch
    (<default>)." + Save branch + Cancel link, error directly under the field, pending status,
    explanatory note. Action `changeRepositoryBranchAction`: Zod-parsed id and branch; invalid
    -> panel with field error; scan active -> page error; enqueue -> `?branchChange=<job>`.
    Page shows pending (disabled field, AutoRefresh), success line, or the panel with the
    field error (value kept).
16. Branch cell: mono name plus caption "Default branch" / "Chosen. Default: <b>" / "Checked
    out (scans the working tree)"; Last scan cell adds "That scan read <scanned>: scan again to
    read <current>." (warning tone) when `scanned_branch` differs from the effective branch;
    error and warning cells wrap instead of truncating (screenshots).
17. Copy in the two card descriptions updated for the branch (no en/em dash in new copy).

### Tests (red first), specs, docs

18. Unit tests for every new branch (core table, database schemas/functions/migration, runner
    with real git against local bare repositories over `file://` and a logging git on PATH,
    web lib), 100% coverage. Playwright: register with/without branch, invalid branch (field
    error, focus, aria), branch not found, change branch open/cancel/save (jobs held pending by
    a trigger, the test plays the runner; nothing reaches github.com), refused while scanning,
    keyboard only, both themes, 320 px, contrast. Storybook: real stories for the register form
    Branch states and the change panel states (not the temporary proposal story).
19. Specs: SPEC-104 (FR-104-07 rewritten, list to §19, FR-104-10/14/16, §8, §10, §11, §13,
    §14, Phasing step, §20), SPEC-105 (§9.1 step 0/1 cache rule, FR-105-05, FR-105-10 and §20
    hash incl. branch, §14, scan result `branch`), SPEC-125 one sentence, database schema spec
    (`scanned_branch`, job type, result `branch`).

### Plan review (Codex, sceptical staff engineer): all 10 findings adopted

None changes an approved decision.

1. (high) Credential echo: `mayCarryCredentials` applies to the raw path and the raw branch
   independently, in both actions and when the page reads `?branchName=`; an echoed branch is
   bounded (256 characters). Tests with raw, percent-encoded, double-encoded and hand-made
   query values.
2. The branch job validates the stored location exactly like the hosted scan
   (`parseRepositoryUrl`, canonical equality, `REPOSITORY_ID`) before git runs.
3. `setRepositoryBranch` takes the job id and signal and re-checks inside its transaction that
   the job is still running without a cancellation request (as `assertScanStillRunning`);
   otherwise the job is cancelled/interrupted and nothing is written.
4. `enqueueRepositoryBranchJob` reuses an active branch job only for the identical request;
   a different active request is refused (`branch-change-active`, page error).
5. A missing Branch form field (the "Register anyway" form) means empty; a file upload is
   rejected. Confirmation flows keep a test.
6. Opening the panel focuses the Branch input (B9), not only after errors; asserted in
   Playwright after mouse and keyboard opening and after both error kinds.
7. The "That scan read X" warning shows only for hosted rows with a known `scanned_branch`
   that differs from the effective branch (null after the migration, never scanned, local:
   no warning).
8. B11 integration cases are listed explicitly (below).
9. Spec updates go first (one docs commit before the code), implementation status last.
10. The "already registered" note compares normalised choices (typed default == stored null).

Explicit runner integration tests (real git, `file://` bare remotes, logging git on PATH):
registration with existing / missing branch (one `ls-remote`, nothing stored when missing);
change job ok / not found / unreachable / repository removed meanwhile / cancelled before the
write / malformed stored location; scan after a change deletes a cache holding the old ref and
clones (log shows `clone`, cache lists only the new ref); same head commit on two branches scans
in full (hash differs); branch changed (and default refreshed by re-registration) during a full
scan and during an unchanged scan fails with nothing applied; chosen branch deleted upstream
keeps occurrences with the new message; old-branch-only artifacts become Missing and reappear
after switching back.

## Decisions

- Re-registering an already registered URL with a branch does not change its branch (the
  conflict update only refreshes `default_branch`, as today): a branch change goes through the
  change job and its "no change while a scan is pending or running" rule. The done line then
  says "<subject> is already registered. Its branch was not changed: use Change branch."
  when the typed branch, normalised against the detected default, differs from the stored
  choice.

## Work performed

(in progress)

## Verification

(in progress)

## Problems and deviations

## Lessons recorded

## Follow-ups

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Specs first

- [ ] 1.1 Update SPEC-104, SPEC-105, SPEC-125 and the database schema spec

### Phase 2: Core and database

- [ ] 2.1 branchNameSchema and isSafeBranchName in core
- [ ] 2.2 scanned_branch migration and schema
- [ ] 2.3 Job schemas, enqueue and setRepositoryBranch, scan apply branch re-check

### Phase 3: Runner

- [ ] 3.1 checkRemoteBranch and the cache ref rule
- [ ] 3.2 Registration with a branch and the repository-branch job
- [ ] 3.3 Branch in the scan config hash, scan result and messages

### Phase 4: Web

- [ ] 4.1 Actions and lib helpers
- [ ] 4.2 Register form Branch field and change panel
- [ ] 4.3 Storybook stories
- [ ] 4.4 Playwright tests

### Phase 5: Verification and review

- [ ] 5.1 Full quality gate
- [ ] 5.2 Real-app run and browser QA with evidence
- [ ] 5.3 Codex adversarial review until approved
- [ ] 5.4 om-auto-review-pr with autofix
- [ ] 5.5 Implementation status, lessons and run log finalised
