---
title: Fix the quadratic slug allocation found by the final Codex review of PR #44
date: 2026-10-20
agent: Claude Code / claude-opus-5-5
trigger: coordinator request. The final Codex adversarial review (gpt-6.1-sol) at 6e952f6 returned one medium finding; the coordinator verified it and the maintainer decided to fix it in this PR
status: completed
branch: feat/issue-16-scan-local-repository
specs: [SPEC-101, SPEC-105]
---

# Run: PR #44, slug allocation without a query per candidate

Previous round: [2026-10-20-pr-44-review-fixes.md](2026-10-20-pr-44-review-fixes.md).

## Objective

Fix the Codex finding at `6e952f6`. `freeSlug` probed `base`, `base-2`, … with one query per
candidate and restarted at `base` for every new artifact. N same-named new artifacts therefore
cost about N²/2 queries while `applyRepositoryScan` held `BEGIN IMMEDIATE`. The fix had to keep
SPEC-101 rule 4 exactly (the first free of `base`, `base-2`, `base-3`, …, in a deterministic
order). It had to handle `%`, `_` and `\` in a base, and bound the query growth with a test that
fails on the old code. Out of bounds: the maintainer's 2026-10-19 decisions and earlier rounds'
fixes.

## Plan

1. Write the regression tests first and run them against the old code.
2. Replace `freeSlug` with a transaction-scoped allocator shared by both write paths.
3. Update the specs' implementation status, run the full gate, check the change in a real scan,
   commit, push, triage on the PR, then run an independent review of the final head.

## Decisions

- **One allocator per transaction, shared by both paths.** `slugAllocator(db)` is created inside
  each `withTransaction` callback: once per `applyRepositoryScan`, and once per
  `importArtifactVersion` call. `writeArtifactVersion` takes it as a parameter. That was simpler
  than keeping `freeSlug` for single imports, and every path is now covered by the same tests.
- **One read per base, and one taken-set for all bases.** The first request for a base reads
  `slug = base` or `slug` in the BINARY range [`base-`, `base.`). Every later candidate is checked
  in memory, with a per-base cursor that never moves back. The set is shared across bases because
  base `agents-md-3` can take a slug that base `agents-md` would also reach, and the reverse. A
  test covers both orders.
- **A range, not `LIKE`.** `'.'` (0x2E) follows `'-'` (0x2D), so under the column's default BINARY
  collation the range holds exactly the slugs that start with `base-`. It has no wildcard to
  escape, it does not fold case the way `LIKE` does, and it is a range scan of
  `artifacts_slug_unique`.
- **Why the memory is exact.** Under `BEGIN IMMEDIATE` no other writer can insert, and every
  artifact the transaction inserts takes its slug from the allocator, which records it.

## Work performed

- `a5f90e0` fix(database): allocate rule-4 slugs without a query per candidate. This commit holds
  the code, three new tests in `packages/database/test/artifacts.test.ts`, and the status lines
  in SPEC-105 §20 (FR-105-09 subset) and in the implementation status of SPEC-101.
  - 3,000 skills named `review` in `packages/p<i>/.agents/skills/review`, applied through
    `applyRepositoryScan`, get `review`, `review-2` … `review-3000` in input order. The test counts
    statements through `vi.spyOn(handle.sqlite, 'prepare')`: exactly one statement reads
    `"artifacts"."slug"`, and fewer than 8 statements are issued per artifact. It uses a named
    30 s timeout instead of a wall-clock assertion.
  - Gaps and cross-base collisions across two scans. Slugs that earlier scans took
    (`agents-md`, `agents-md-2`, `agents-md-4`) are skipped, and the gap at `-3` is filled first.
    Base `agents-md-6`, read after base `agents-md`, makes later `agents-md` artifacts skip `-6`.
    Base `agents-md-3`, read after base `agents-md` took that slug, gets `agents-md-3-2`.
  - Bases with `%`, `_` or `\`, through `importArtifactVersion` across two providers: `a_b-2`,
    `a_b-3`, `a%b-3`, `a\b-2`, and `axb` (free even though `axb-2` exists). Base `a` gives `a-2`
    and `a-3` next to `a-b` and `a.b`.
- This run log, and the lesson
  [2026-10-20-no-query-per-candidate-in-a-write-transaction.md](../lessons/2026-10-20-no-query-per-candidate-in-a-write-transaction.md).

## Verification

- **Old code** (`6e952f6`'s `artifacts.ts` with the new tests): the 3,000-artifact test failed
  with `expected [ …(4501500) ] to have a length of 1 but got 4501500`. That is exactly
  3000·3001/2 slug statements, after 82 s. The other two new tests passed, as expected, because
  the semantics are unchanged.
- **New code:** the 3,000-artifact test takes 1.2 s locally.
- **Real scan (temporary test file through `LocalRunner`, not committed):** a file-backed
  database in WAL mode, a registered directory with 2,000 `packages/p<i>/.agents/skills/review/SKILL.md`
  (`name: review`), one scan job.
  - Old code: completed in **34.2 s**.
  - New code: completed in **1.2 s**, with 2,000 unique, sequential slugs (`review` …
    `review-2000`).
- **Full gate at `a5f90e0`:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
  pnpm build && pnpm verify:pack && pnpm test:e2e` all green.
  - 703 unit tests: core 175, database 111 (+3), runner 106, web 92, CLI 75, benchmark-engine
    110, agent-adapters 34.
  - 100% coverage in every package, with no threshold, exclusion or `v8 ignore` change.
  - `Packaging verification passed`; Playwright 27 passed.
- CI and the independent review of the final head are reported on the PR.
- **Not verified:**
  - macOS and Windows. The range relies on SQLite's BINARY collation, which is the same on every
    platform.
  - Concurrent web writes during a large scan. The finding's busy-timeout risk is removed by
    shortening the lock, not tested directly.
  - Scans with tens of thousands of distinct bases: one read per distinct base, as before, since
    the old code also issued one query for a free base.

## Problems and deviations

- The finding's example does not happen as stated. Discovery names a nested `AGENTS.md` (and
  `CLAUDE.md` and the other always-on instruction files) by its path, such as
  `packages/p0/AGENTS.md` → `packages-p0-agents-md`, so nested `AGENTS.md` files do not share a
  slug base within one scan. The quadratic case is real for skills that share a frontmatter
  `name`, and for Cursor, Copilot or Claude rules that share a basename across packages. The
  regression and the manual scan use that case. The finding is valid, with a corrected trigger.
- No change to the maintainer's decisions or to earlier rounds' fixes.

## Lessons recorded

- [2026-10-20-no-query-per-candidate-in-a-write-transaction.md](../lessons/2026-10-20-no-query-per-candidate-in-a-write-transaction.md)

## Follow-ups

None. QA by a QA reviewer is still required (`needs-qa`, risk-high).
