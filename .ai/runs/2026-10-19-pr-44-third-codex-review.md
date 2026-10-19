---
title: Fix the third Codex review findings on PR #44
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: coordinator request. The maintainer asked for every Codex adversarial review to be followed by fixes for the valid findings; the third Codex review (gpt-6.1-sol) at 8ee0368 returned two medium findings, both checked as valid by the coordinator
status: in-progress
branch: feat/issue-16-scan-local-repository
specs: [SPEC-102, SPEC-105, SPEC-114]
---

# Run: PR #44, third Codex review

## Objective

Fix both findings of the third Codex review at `8ee0368` on the PR branch, without merging and
without changing the maintainer's 2026-10-19 decisions or earlier rounds' fixes:

1. **[medium] Frontmatter that JSON cannot represent poisons the whole scan.** A cyclic alias
   (`metadata: &a {self: *a}`) parses to a circular object; storing it threw inside the single
   scan transaction, so every artifact rolled back, every retry failed, and the UI said only
   "unknown error".
2. **[medium] Shutdown can exceed its deadline.** After `shutdownTimeoutMs`, `stop()` awaited
   `interruptJobs` with no budget; behind a transaction a stuck job held, it never returned, and
   the CLI awaits `stop()` before it terminates the web child.

Acceptance: regression tests that fail on the old code, 100% coverage with no threshold or
exclusion change, the full gate plus Playwright, specs updated only for verified behaviour, a
triage comment, and an independent review of the final head.

## Plan

1. Core: after `parse`, walk the value and allow only JSON values (null, string, boolean, finite
   number, array, plain or null-prototype object), tracking ancestors for cycles. Anything else is
   invalid frontmatter (`error` set, empty `frontmatter`), so `parseArtifactFile` adds the usual
   `Invalid frontmatter: …` warning. Pin `maxAliasCount` as a named constant.
2. Database: wrap a per-artifact write failure inside `applyRepositoryScan` in an
   `ArtifactStoreError` carrying the repository-relative path; runner: name that path in the
   scan failure message (redacted, never the cause's text).
3. Runner: race `interruptJobs` against a named `SHUTDOWN_INTERRUPT_GRACE_MS`; catch its
   rejection; log the skipped and the failed case with their own events.
4. Tests, specs (SPEC-102, SPEC-105, SPEC-114), lessons, gate, real run, push, PR body, triage,
   independent review.

## Decisions

- **Reject, do not normalise.** A `Date` or `Buffer` could be converted, but the finding asked for
  invalid-frontmatter handling, and converting would store something other than what the file
  says. Untagged dates stay strings under YAML 1.2, so only explicit `!!timestamp` is affected.
- **Validate with a walker, not `JSON.stringify` in a `try`.** `stringify` catches cycles and
  BigInt, but silently rewrites `.inf`, `Set`, `Map`, `Date` and `Buffer`.
- **Fail closed for values `yaml` does not produce with these options** (bigint, undefined,
  non-plain objects): covered by mocking the parser, as the existing non-Error test does.
- **`MAX_FRONTMATTER_ALIAS_COUNT = 100`** — the `yaml` default, already bounding alias bombs
  (verified: a 10^6 expansion throws "Excessive alias count"), now pinned. No depth limit: the
  parser itself fails with a `YAMLParseError` at roughly 800 levels of nesting.
- **Grace of 1 s, as a constant, not an option** (no speculative options). The skipped write is
  not cancelled: it still lands if the transaction ends while the process lives. Otherwise
  `recoverStaleJobs` marks the jobs `interrupted` at the first runner start after their heartbeat
  is older than 30 s; a restart within 30 s leaves them `running` until a later start — the same
  limitation as after a crash, now documented in SPEC-114 §14.

## Work performed

- `bf62209 fix(core)`: `parseFrontmatter` walks the parsed value (`jsonIncompatibility`) and
  returns `error: 'frontmatter cannot be stored as JSON: <problem>'` with empty frontmatter for
  cycles, `.inf`/`.nan`, `Buffer`/`Set`/`Map`/`Date` and other non-JSON values;
  `MAX_FRONTMATTER_ALIAS_COUNT = 100` is passed as `maxAliasCount`. Tests in
  `packages/core/test/frontmatter.test.ts` (cycles, shared alias, each tag, untagged date and
  `__proto__` key, alias bomb, fail-closed values through a mocked parser) and a runner
  integration test (a cyclic-alias skill next to a valid `AGENTS.md`). SPEC-102 FR-102-05, §12,
  §13 and §20.
- `dc11903 fix(runner)`: `ArtifactStoreError` (database) carries the occurrence path of the
  artifact whose write failed; `scanLocalRepository` reports
  `The scan failed: the results for <path> could not be stored (<code>).`, redacted. Tests in
  `packages/database/test/artifacts.test.ts` (a circular `parsedMetadata` next to a valid artifact
  rolls back and names the path) and `packages/runner/test/repository-scan-errors.test.ts`.
  SPEC-105 §20.
- `2e4c6a7 fix(runner)`: `stop()` delegates to `interruptRemaining()`, which races
  `interruptJobs` against `SHUTDOWN_INTERRUPT_GRACE_MS`, catches its rejection
  (`shutdown-interrupt-failed`) and logs a skipped write (`shutdown-interrupt-skipped`). Tests in
  `packages/runner/test/runner-lanes.test.ts`. SPEC-114 §14 and §20 (FR-114-13, FR-114-15).
- Docs: this run log and two lessons.

## Verification

- Old-code checks, each new regression run against the reverted source:
  - **Cyclic-alias scan** (`repository-scan.test.ts`), with the old `frontmatter.ts`: fails —
    the scan result is `ok: false` instead of `ok: true` with two artifacts.
  - **Shutdown** (`runner-lanes.test.ts`, "returns within its deadline plus the grace…"), with
    the old `runner.ts`: fails — `stop()` is "still waiting" after deadline + grace + 1 s.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build &&
  pnpm verify:pack && pnpm test:e2e`: exit 0. Test counts: core 170, database 107, runner 103,
  web 92, CLI 75, benchmark-engine 110, agent-adapters 34, for 691 in total. Statements,
  branches, functions and lines are at 100% in every package; no threshold, exclusion or
  `v8 ignore` change. "Packaging verification passed". Playwright: 27 passed.
- Real app: the built CLI (`demo`, then `serve --port 4411`, temporary data directory), driven
  by a Playwright script: registering a local directory with
  `.agents/skills/loop/SKILL.md` (`metadata: &a {self: *a}`) and `AGENTS.md`, then **Scan**,
  reported "Scanned cyclic-repo: 2 files in 24 ms, 2 artifacts found (2 new, 2 new versions),
  0 errors."; the stored skill version has `frontmatter: {}` and the warning
  `Invalid frontmatter: frontmatter cannot be stored as JSON: it contains an alias that refers to
  itself`; `sync_status = 'ok'`. SIGINT then stopped `serve` (runner and web child) in 113 ms.
- Not verified:
  - A real `serve` shutdown while a job holds a transaction past the deadline (only the
    regression test, with a held `withTransaction`, exercises it).
  - Recovery of a job left `running` through a real CLI restart; the behaviour relies on the
    existing `recoverStaleJobs` (tested in `packages/database/test/jobs.test.ts`).
  - A cross-process lock (another process holding the SQLite write lock): `node:sqlite` waits
    synchronously up to `busy_timeout` (5 s), during which the grace timer cannot fire; the
    write then fails and is logged as `shutdown-interrupt-failed`. Reasoned, not tested.
  - macOS and Windows.

## Problems and deviations

- The first draft of the failure test closed the database handle to make `interruptJobs` fail;
  that left the held job unable to finish without an unhandled rejection. Renaming the `jobs`
  table around `stop()` makes the write fail at once and lets the job finish afterwards.
- No deviation from the maintainer's decisions or from earlier rounds' fixes.

## Lessons recorded

- [Parsed YAML is not JSON — check it before it reaches a JSON column](../lessons/2026-10-19-parsed-yaml-is-not-json.md)
- [A shutdown deadline must bound every await after it, cleanup writes included](../lessons/2026-10-19-bound-every-await-after-a-deadline.md)

## Follow-ups

- A restart within 30 s of a shutdown whose interrupt write was skipped leaves the jobs `running`
  until a later start (recovery runs only at runner start; same limitation as after a crash,
  SPEC-114 §14). Not filed: SPEC-114 already lists the data-dir lock as an open item, which would
  let a new runner recover its predecessor's jobs immediately.
- Independent review of the final head: see the PR.
