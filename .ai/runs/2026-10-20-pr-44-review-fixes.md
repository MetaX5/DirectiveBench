---
title: Fix the independent review findings on PR #44 at 2d668f3
date: 2026-10-20
agent: Claude Code / claude-opus-5-5
trigger: coordinator request. The independent review of 8ee0368..2d668f3 returned REQUEST CHANGES (posted on the PR on 2026-10-19 21:33 UTC); the maintainer wants the findings fixed and the PR finished up to his approval
status: completed
branch: feat/issue-16-scan-local-repository
specs: [SPEC-102, SPEC-105, SPEC-114]
---

# Run: PR #44, fixes for the review at `2d668f3`

Previous round: [2026-10-19-pr-44-third-codex-review.md](2026-10-19-pr-44-third-codex-review.md).

## Objective

Fix every finding of the independent review of `8ee0368..2d668f3` on the PR branch, without
merging and without changing the maintainer's 2026-10-19 decisions or earlier rounds' fixes beyond
what the findings need:

- **M1 (major).** `MAX_FRONTMATTER_ALIAS_COUNT` does not cap size, although the comment and
  SPEC-102 said so: a ~1 MB `SKILL.md` with `a: &a "<1 MB>"` and `b: [*a ×99]` parsed and was
  stored as ~100 MB of JSON.
- **m1.** "The late write still lands" is false under `serve`: the database is closed after
  `stop()`, so the queued interrupt write fails and was logged as an error after shutdown.
- **m2.** `ArtifactStoreError` blamed the artifact being written for connection-level failures.
- **m3.** One non-JSON value discards the whole frontmatter: undocumented, and the warning did
  not name the key.
- **Nits.** A non-Error rejection in `interruptRemaining`; FR-114-15 claimed the new events were
  verified in `runner.log`.

## Plan

1. Core: count the exact UTF-8 bytes of the compact JSON inside `jsonIncompatibility`, against a
   budget of `MAX_FRONTMATTER_JSON_BYTES`, re-walking shared nodes once per alias and stopping as
   soon as the budget is spent. Track the path so the warning names the top-level key. Count each
   artifact's frontmatter JSON in `maxScanBytes`.
2. Runner: log an interrupt write that fails after the grace expired as information; report the
   SQLite cause, and `String(error)` for a non-Error.
3. Database and runner: neutral store-error wording that names where the write stopped.
4. Specs, lessons, gate, real run, push, PR body, triage, independent review of the final head.

## Decisions

- **`MAX_FRONTMATTER_JSON_BYTES = 4 MiB`** (4 × the 1 MiB primary-file limit). Frontmatter
  without aliases serialises to roughly its own size (JSON adds quotes and commas); the measured
  worst cases are 2.2–2.9× for `~` lists, `\0` escapes and empty values, and up to 6× only for
  text that is mostly raw control characters (`yaml` accepts them; JSON writes each as `\u00XX`).
  So any real frontmatter fits, while one 1 MiB file can no longer expand ~100×.
- **Exact byte count inside the walk, not `JSON.stringify` and a length check.** The walk already
  visits every node; counting there stops at the cap instead of building the 100 MB string first.
  A string costs `Buffer.byteLength(JSON.stringify(s))`; the boundary test proves the total equals
  `Buffer.byteLength(JSON.stringify(frontmatter))`.
- **Also count frontmatter JSON in `maxScanBytes`** (beyond the finding's literal ask). A per-file
  cap alone does not bound a scan: about 6,000 files of ~42 kB, each expanding ~100× to the 4 MiB
  cap, fit in 256 MiB of content and would store ~25 GB. Counting the JSON makes the scan-wide
  stored metadata at most 256 MiB. Real frontmatter is a few hundred bytes, so real scans are
  unaffected.
- **Name the top-level key only**, JSON-quoted (no raw newlines in a warning) and cut to 64
  characters (`MAX_REPORTED_KEY_LENGTH`). The value is never quoted. Whole-block rejection stays
  (fail closed); FR-102-05 now says so and names the fallbacks.
- **m1: info after the grace, whatever the cause.** Once `shutdown-interrupt-skipped` has been
  logged, any later failure of that write matches what was already reported. So it is logged as
  `shutdown-interrupt-abandoned` (info) with the cause. No matching on "database is not open".
- **m2: reword, not reclassify.** Wrapping only non-SQLite errors would need a classification of
  Drizzle-wrapped errors. The path now says where the write stopped: "The scan failed while
  storing the results at <path> (<code>)."

## Work performed

- `bf601fe fix(core)`: `MAX_FRONTMATTER_JSON_BYTES`, the budgeted walk, key naming in the warning,
  frontmatter JSON counted in `maxScanBytes`. The `MAX_FRONTMATTER_ALIAS_COUNT` comment is
  corrected. Tests: `packages/core/test/frontmatter.test.ts` (1 MB × 99 aliases; exact boundary,
  at the limit and one byte over; key naming, including a long and escaped key and a self-referring
  root; a non-plain root through the mocked parser), `packages/core/test/discovery.test.ts`
  (frontmatter JSON in the scan limit; a 2 kB skill expanding to ~50 kB aborts a 10 kB limit),
  `packages/runner/test/repository-scan.test.ts` (the 1 MB × 99 skill is stored with empty
  frontmatter, its name falls back to `wide`, and `parsed_metadata` stays under 10 kB). SPEC-102
  FR-102-05, FR-102-16, §12, §13 and §20. New lesson; the 2026-10-19 YAML lesson points to it.
- `7de14e6 fix(runner)`: `interruptRemaining` logs a failure after the grace as
  `shutdown-interrupt-abandoned` (info); the reason is the SQLite cause (not Drizzle's
  "Failed query: … params: …") or `String(error)`. Tests in
  `packages/runner/test/runner-lanes.test.ts`: the queued write fails after `stop()` returned
  (table renamed inside the held transaction); a non-Error and a cause-less Error rejection
  (through a `vi.fn` wrapper around the real `interruptJobs`); the existing failure test now
  checks the exact message. SPEC-114 §14, FR-114-13/15 in §20; the shutdown lesson.
- `d0981f3 fix(runner)`: neutral `ArtifactStoreError` message and scan message. Tests: a full
  database (`pragma max_page_count`) gives an `ArtifactStoreError` with the path and the cause
  `database or disk is full`; the unserialisable-metadata case stays; the runner unit test covers
  a connection cause and an artifact cause. SPEC-105 §20.
- Docs: this log, and the previous log finalised.

## Verification

- Old-code checks (each new regression run against the reverted source file):
  - `frontmatter.test.ts` "rejects a 1 MB string repeated by 99 aliases…" with the old
    `frontmatter.ts`: **fails** (the frontmatter is returned as valid).
  - `repository-scan.test.ts` "stores a skill whose aliases expand past the frontmatter JSON
    limit…" with the old `frontmatter.ts`: **fails** (`name: 'wide-name'` stored with the
    100 MB frontmatter).
  - `discovery.test.ts` "counts the expanded frontmatter JSON…" and the updated byte-limit test
    with the old `discovery.ts`: **both fail**.
  - `runner-lanes.test.ts`, the late-failure test and both message tests, with the old
    `runner.ts`: **all three fail**.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`: exit 0. Test counts: core 175,
  database 108, runner 106, web 92, CLI 75, benchmark-engine 110, agent-adapters 34, for 700 in
  total. Statements, branches, functions and lines are at 100% in every package; no threshold,
  exclusion or `v8 ignore` change.
- `pnpm build && pnpm verify:pack && pnpm test:e2e`: exit 0. "Packaging verification passed";
  Playwright: 27 passed.
- Real app: the built CLI (`serve --port 4412`, temporary data directory), driven by a Playwright
  script. A local directory held a 1,048,035-byte `wide/SKILL.md` (1 MB string, 99 aliases), a
  `dated/SKILL.md` with `date: !!timestamp 2026-10-19`, and `AGENTS.md`. Register, then **Scan**,
  reported "Scanned repo: 3 files in 107 ms, 3 artifacts found (3 new, 3 new versions), 0 errors."
  Stored: `wide` with 290 bytes of `parsed_metadata` and the warning `Invalid frontmatter:
  frontmatter cannot be stored as JSON: it expands to more than 4194304 bytes of JSON under the
  key "b"`; `dated` (name fallen back from `dated-name`) with `… it contains a Date under the key
  "date"`; `sync_status = 'ok'`. SIGINT stopped `serve` cleanly, with no `shutdown-interrupt-*`
  line in `runner.log`.
- Not verified:
  - A real `serve` shutdown whose interrupt write misses the grace and then hits the closed
    handle. The unit test makes the queued write fail after `stop()` returned (dropped table),
    not through a closed handle (closing it would leave the held job unable to finish).
  - The exact worst-case expansion of alias-free frontmatter: 6× is measured for raw control
    characters, not proven to be the maximum. Over 4 MiB it is invalid frontmatter, not a failure.
  - macOS and Windows.

## Problems and deviations

- Drizzle wraps the SQLite error: the first version of the late-failure test expected
  `no such table: jobs` and got "Failed query: update … params: …". The log now reports the cause.
- CI at `e6c0736` failed the unit job: the exact-boundary test parsed three 4 MiB YAML sources and
  took 5.7 s on the runner (0.9 s locally), past Vitest's 5 s default. It now reaches the limit
  with 99 aliases of a 41,000-character chunk (a ~135 kB source; 67 ms locally), and the 1 MB test
  sums the expanded lengths instead of serialising 100 MB. Same assertions, same exact boundary.
- Deviation from the finding's literal request: the frontmatter JSON also counts towards
  `maxScanBytes` (see Decisions). SPEC-102 FR-102-16 is updated to say so.
- No change to the maintainer's decisions or to earlier rounds' fixes beyond these findings.

## Lessons recorded

- [An alias limit is not a size limit — cap the expanded output itself](../lessons/2026-10-20-alias-limits-are-not-size-limits.md)
- Updated: [Parsed YAML is not JSON](../lessons/2026-10-19-parsed-yaml-is-not-json.md) (links the
  new lesson) and [A shutdown deadline must bound every await after it](../lessons/2026-10-19-bound-every-await-after-a-deadline.md)
  (the skipped write may not land, because the caller can close the resource).

## Follow-ups

- None filed. The 30 s recovery window after a skipped interrupt write stays as documented in
  SPEC-114 §14.
- Independent review of the final head: see the PR.
