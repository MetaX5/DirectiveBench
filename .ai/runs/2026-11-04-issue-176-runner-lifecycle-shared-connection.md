---
title: One writable connection in the runner-lifecycle two-runner tests (issue #176)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: maintainer asked to fix issue #176; run through om-auto-fix-issue
status: completed
branch: fix/issue-176-runner-lifecycle-shared-connection
specs: []
---

# Run: One writable connection in the runner-lifecycle two-runner tests (issue #176)

## Objective

`packages/runner/test/runner-lifecycle.test.ts` "two runners sharing one database" gave runner
`b` a second writable `node:sqlite` connection (`secondHandle()`) in the vitest thread, the hazard
that made #174 flaky. Acceptance criteria (issue #176): one writable connection per thread (or the
second runner in a real separate process or worker); the tests still prove that two runners split
one queue without claiming a job twice; no timeout raised; `os.tmpdir()` directories removed.

## Plan

1. Triage (`om-verify-in-repo`): no open or merged PR and no commit references #176;
   `secondHandle()` is still on `main`.
2. Both runners share the file's one connection; drop `secondHandle()` and `extraHandles`.
3. Show the tests still catch a double claim with a temporary non-atomic `acquireNextJob`.
4. Quality gate, review, PR.

## Decisions

- Shared connection instead of a worker: the guarantee these tests check lives in
  `acquireNextJob`'s single conditional `UPDATE … RETURNING`, and the two runners' `poll()` calls
  still interleave on the event loop, so a non-atomic claim is still caught (step 3 of Work
  performed). Atomicity of one SQLite statement across connections is SQLite's guarantee, not
  something these tests need to re-prove; a worker would add a second process lifecycle to a
  unit test for no extra coverage. This matches the #174 fix (PR #175) and the lesson
  `2026-11-04-one-writable-connection-per-test-thread`.
- No timeout changed. The file's `afterEach` already removes its `os.tmpdir()` data directory.

## Work performed

1. `runner-lifecycle.test.ts`: both runners in the describe use `handle`; removed
   `secondHandle()` and the `extraHandles` cleanup it needed; added a comment on why.
2. Mutation check (temporary, reverted, not committed): `acquireNextJob` changed to select the id,
   yield one macrotask, then update by id without the `pending` guard. Both tests failed:
   "acquires a single pending job exactly once" `expected 2 to be 1`, "splits a queue between
   runners" `expected 6 to be 5`. With the real `acquireNextJob` both pass.
3. Checked the other runner test files: each opens exactly one connection.

## Verification

| Command | Result |
| --- | --- |
| `vitest run test/runner-lifecycle.test.ts` (runner) | pass, 25/25 |
| mutation check above | both two-runner tests fail as expected, then pass after revert |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 7/7 tasks, 100% coverage in every package (runner 16 files) |
| `pnpm build` / `pnpm verify:pack` (review gate, `TMPDIR` on disk) | pass / "Packaging verification passed" |

Review: `om-auto-review-pr 178 --autofix` ran the full `validation.commands` gate (all pass) and
found no blocker, major, minor or nit. The verdict was approve, posted as a comment review because
the reviewer is the author, so no autofix round was needed.

Not verified: the hazard was never seen failing (issue #176), so there is no
red-first run of the original flake; the mechanism was proved deterministically in PR #175.

## Problems and deviations

- Prettier wanted the shortened `createRunner` calls on one line; fixed with `prettier --write`.

## Lessons recorded

None new: the existing lesson `2026-11-04-one-writable-connection-per-test-thread` covers this.

## Follow-ups

- None from this run.
