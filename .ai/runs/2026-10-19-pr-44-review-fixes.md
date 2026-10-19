---
title: Fix the independent review findings on PR #44 and apply the maintainer's decisions
date: 2026-10-19
agent: Claude Code / claude-opus-5-5 (om-auto-fix-pr → om-auto-review-pr --autofix)
trigger: coordinator request — drive PR #44 (issue #16) to merge-ready after the COMMENT review at 9c6508d
status: completed
branch: feat/issue-16-scan-local-repository
specs: [SPEC-101, SPEC-102, SPEC-104, SPEC-105, SPEC-114]
---

# Run: PR #44 review fixes and maintainer decisions

## Objective

Fix every finding of the independent second review of PR #44 (one major, four minors, two nits)
and fold in the five decisions the maintainer took on 2026-10-19, without merging. Acceptance:
each finding fixed with a test that fails on the old code where a test can show it, specs and the
PR body no longer overclaim, 100% coverage, the full gate and Playwright green, and a final
independent review of the final head.

## Plan

1. Base: `origin/main` (355e8f6) was already contained in the PR head (ca1cbf2); no merge needed.
2. Database: run the foreign-transaction check and the statement in one synchronous step;
   identify the `withTransaction` call (not the connection) in the async scope; reject nesting.
3. Core: re-`realpath` each directory before listing it and each file's directory before opening
   it; relative paths plus error codes in `read-failed` messages; a `skipDirectories` option.
4. Runner: classify every location/stat error, mark every failure (`sync_status = 'error'`),
   keep absolute paths and query parameters out of messages, finish a scan that could not run as
   a `failed` job; `stop()` waits for a poll in flight; skip user-level agent folders (D05).
5. Web: truthful "interrupted" copy, page-level error for a Scan that cannot enqueue, D05 copy in
   the home confirmation, the skipped-folders line.
6. Specs, lessons, this log; then an independent review of the final head.

## Decisions

- **Typed scan failures finish the job as `failed`** (they completed with `ok: false` before).
  The review asked for failures to be marked and reported as such; a failed job is what the jobs
  list and the coordinator expect, and the typed outcome stays in `jobs.result`. The page shows
  the outcome's own message.
- **Apply failures report only an error code** (`ERR_SQLITE_ERROR`, …): Drizzle's "Failed query"
  message carries the query parameters, i.e. file contents.
- **User-level folders (maintainer decision 5, D05):** SPEC-102 §3 named none, so the list comes
  from the integration specs: `~/.agents`, `~/.claude`, `~/.codex`, `~/.cursor`,
  `$XDG_CONFIG_HOME/cursor` (default `~/.config/cursor`), plus `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
  when absolute; both the spelling below the canonical home and the symlink target are skipped.
  Whole folders are skipped, not only their `skills/` subfolders. A location that is or lies
  inside one reads nothing. Reported as `skippedUserLevelFolders` (one informational line), not
  as discovery errors. The confirmation copy does not cite "D05" (users do not know the id).
- **Decisions 1–4** are recorded as decided in SPEC-104 OQ-104-02/OQ-104-06, SPEC-102 Phasing and
  §20, SPEC-105 §20 (NFR-105-03 as an accepted M1 deviation with the 2.4 s measurement and a
  "revisit batching" follow-up note), SPEC-114 FR-114-11 and SPEC-101 §20. No code change.
- **Nits fixed instead of filed:** `stop()` during an in-flight acquire and the nested
  `withTransaction` deadlock were both small and safe.

## Work performed

Commits on `feat/issue-16-scan-local-repository` after ca1cbf2 (see `git log`):

1. `fix(database)` — `foreignTransaction()` is synchronous and the proxy loops
   `for (let open = check(); open; open = check()) await open;` immediately before `prepare`.
   The ALS store is the `withTransaction` call's token; nested calls reject.
2. `fix(core)` — directory and file-parent `realpath` re-checks, `errorCode()` in messages,
   `skipDirectories` / `skippedDirectories`.
3. `fix(runner)` — `checkLocation` never throws; `discoveryFailure`, apply failures marked;
   `userLevelAgentFolders()`; `finishAs('failed', …)` for `ok: false`; `stop()` awaits `polling`;
   `skippedUserLevelFolders` in the scan result schema (defaults to `[]` for stored results).
4. `fix(web)` — `describeScan` copy and `info`, `scanRequestError`, `scanRepositoryAction`
   redirects with `?scanError=`, page alert and info line, confirmation copy; Playwright.
5. `docs(specs)`, `docs(lessons)`, `docs(runs)`.

## Verification

- Regression tests proven against the old code (old source restored temporarily, then the fix):
  - `client.test.ts` "never lets an outside statement join a transaction that begins right next
    to it" — failed on the old proxy at "transaction-first, offset 0" (row lost), passes now.
    The companion "waiting statement" sweep passes on both (kept as a guard).
  - "treats a callback continuation that outlives its transaction as outside code" and "rejects a
    nested withTransaction instead of deadlocking" — failed (lost row; 5 s timeout) on the old code.
  - `discovery-simulated-fs.test.ts` swap tests (directory swapped between listing and descent;
    `references/` swapped between the walk and the read) — failed on the old walker, pass now.
  - `runner-lanes.test.ts` "stop() waits for a job that a poll is claiming…" — failed on the old
    runner (job never aborted), passes now.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`: all green; 649 tests (core 141,
  database 104, runner 93, web 92, CLI 75, benchmark-engine 110, agent-adapters 34), 100% lines,
  branches, functions and statements in every package. No threshold, exclusion or `v8 ignore`
  change.
- `pnpm build && pnpm verify:pack`: passed. `pnpm test:e2e`: 27 passed (one new).
- Real app (built CLI, `HOME` = a temporary home with `~/.claude/skills/global/SKILL.md`,
  `~/.codex/AGENTS.md`, `~/AGENTS.md` and `~/project/.agents/skills/local/SKILL.md`): registering
  `~` shows "… User-level agent folders (~/.claude, ~/.codex, ~/.cursor, ~/.agents) are always
  skipped."; after **Register anyway** and **Scan**: "2 artifacts found (2 new, 2 new versions),
  0 errors" and "Skipped user-level agent folders, which are never scanned: .claude, .codex.";
  `?scanError=not-found` shows the page-level error.
- Independent review of the final head: posted on PR #44 as a COMMENT review (the PR author and
  the agent share one account).
- Not verified: macOS/Windows (`realpath` case and drive-letter behaviour of the new re-checks),
  a real home directory scan, the race window that remains between a `realpath` re-check and the
  read (by design not testable deterministically; documented in SPEC-102 §14).

## Problems and deviations

- The first regression sweep passed on the old code: `Promise.resolve(query)` defers a Drizzle
  query's `then` by one microtask, and calling `then` twice ran the insert twice. The test now
  calls `then` once, synchronously.
- SPEC-105 NFR-105-03 (≤ 1 s apply) remains unmet in the worst case; accepted for M1 by the
  maintainer.

## Lessons recorded

- [2026-10-19-no-await-between-check-and-act.md](../lessons/2026-10-19-no-await-between-check-and-act.md)
- [2026-10-19-confirmation-is-not-opt-in.md](../lessons/2026-10-19-confirmation-is-not-opt-in.md)
- Updated [2026-10-19-shared-connection-transactions.md](../lessons/2026-10-19-shared-connection-transactions.md)

## Follow-ups

- Revisit batched scan writes if the single-transaction write lock hurts in practice (SPEC-105
  §20 note, not an issue by the maintainer's choice).
- Opt-in discovery of user-level folders stays future work (D05, SPEC-102 §19).
- QA by a QA reviewer is still required (`needs-qa`, risk-high).
