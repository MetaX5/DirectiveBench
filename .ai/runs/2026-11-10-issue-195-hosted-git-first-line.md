---
title: Hosted git failure messages name git's error line, not the clone progress line (issue #195)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5
trigger: issue #195 via om-auto-fix-issue
status: completed
branch: fix/issue-195-hosted-git-first-line
specs: [SPEC-104, SPEC-105]
---

# Run: Hosted git failure messages name git's error line (issue #195)

## Objective

A failed hosted `git clone` whose stderr matches neither the not-found nor the unreachable
patterns showed `git failed: Cloning into bare repository '<cache>/…'...`; an unreachable clone
showed the same line after `Could not reach <host>:`. Acceptance (issue #195): the message names
git's `fatal:`/`error:` line, progress lines are skipped, redaction is unchanged, 100% coverage,
no network in tests.

## Plan

om-auto-fix-issue bug chain: verify on `origin/main` → root cause → red tests from real hardened
git output → minimal fix in `firstLine` → gate → PR → om-auto-review-pr --autofix.

## Decisions

- `firstLine` prefers the first `fatal:`/`error:` line; otherwise the first line that is neither
  `warning:` nor a `Cloning into ` progress line; otherwise `no message`. No `--quiet` on the
  clone (the issue rules it out: it changes what git prints and the patterns were recorded
  without it).
- `remote:` lines are not skipped in the fallback: without a TTY git requests no progress, so
  `remote:` lines seen in recordings carry the server's own errors, not progress.
- Trade-off seen in a recording: for a remote missing its root tree, the preferred line is git's
  `error: git upload-pack: git-pack-objects died with error.` while the preceding
  `remote: fatal: bad tree object …` is more specific. The issue's rule (prefer `fatal:`/`error:`)
  was kept; noted as a follow-up option, not changed here.

## Work performed

1. Recorded stderr of the exact hardened clone invocation (git 2.53.0, `LC_ALL=C`, the
   `hostedGitArgs` config, `--bare --filter=blob:none --depth 1 …`): file:// remote without its
   loose objects (`fatal: git upload-pack: not our ref …`), file:// remote without its root tree
   (`remote: fatal: bad tree object …` then `error:`/`fatal:` lines), https to a closed loopback
   port (`fatal: unable to access …: Failed to connect …`), a cache directory git cannot create
   (`<path>: Permission denied`, no prefix). Every one starts with `Cloning into bare repository`.
2. Red tests (see Verification), then the fix in `packages/runner/src/hosted-git.ts`.
3. SPEC-105 §20 implementation status (FR-105-15/17/18 hosted line) names the quoted line.

## Verification

- Red first: the five new `classifyRemoteFailure` cases and the new real-git scan test fail on
  the `origin/main` source (6 failed, each received `… Cloning into bare repository '…'...`).
- Green: `vitest run test/hosted-git.test.ts test/hosted-repository.test.ts` 81 passed.
- Seam check (lesson 2026-11-05): replacing the `fatal:`/`error:` preference with a regex that
  never matches fails 2 tests (missing-tree recording, real-git scan); removing the
  `Cloning into` skip fails 2 tests (permission-denied recording, progress-only case).
- Gate (TMPDIR on /var/tmp): `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` pass;
  `pnpm test` pass (runner 250, core 293, database 215, agent-adapters 364 + 2 skipped,
  benchmark-engine 518, cli 164, web 503; 100% statements/branches/functions/lines everywhere).
- Not run: `pnpm build`, `pnpm verify:pack` (no change to apps/cli, packaging or dependencies);
  no UI change, so no e2e/storybook/browser QA. Not verified against github.com itself: the
  recordings are file:// and loopback https; the change does not touch which stderr is
  classified, only which line is quoted.

## Review

- Round 1 (d7232b4): `om-auto-review-pr --autofix` / `om-code-review`, submitted as COMMENT:
  approve verdict, 0 blockers, 0 majors, 0 minors, 1 nit (this run log still `in-progress`).
  Full configured gate re-run for the review, including `pnpm build` and `pnpm verify:pack`
  (both pass).
- Round 2: nit fixed (run log finalised).

## Problems and deviations

- The first end-to-end attempt used a missing-objects remote; it did not exercise the
  `fatal:` preference (its first non-progress line is already `fatal:`), so the mutation survived.
  Replaced with the missing-root-tree remote, whose `remote:` line comes first.
- `Remote branch … not found` (also recorded) is classified as `branch-not-found` before
  `classifyRemoteFailure`, so it could not serve as the end-to-end case.

## Lessons recorded

None: the existing lessons (record git errors with the exact invocation; prove a backstop's
seam fired) covered what this run needed.

## Follow-ups

- Optional: prefer a `remote: fatal:`/`remote: error:` line when present, since the server's line
  can be more specific than git's generic `error:` line (decision for a maintainer).
