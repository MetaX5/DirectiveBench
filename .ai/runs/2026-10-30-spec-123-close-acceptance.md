---
title: Close the remaining acceptance criteria of SPEC-123 and move it to implemented
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (issue #152, SPEC-123 §20 open items)
status: completed
branch: test/spec-123-close-acceptance
specs: [SPEC-123]
---

# Run: Close the remaining acceptance criteria of SPEC-123

## Objective

SPEC-123's phases 1 to 5 are merged; §20 listed three open items: AC-3 and AC-11 had no browser
test through a real capture, and NFR-123-01 had no timing test. Close them, audit every
acceptance criterion against a named test, and move the spec to `implemented/` if all are
verified. No product code change unless a test exposes a bug.

## Plan

1. AC-3 and AC-11 in Playwright through a real capture: the built CLI's `benchmark run` with a
   fake `claude` against the e2e data directory (`serve` is mock-only, FR-118-05).
2. NFR-123-01 as a CPU-time test with a generous bound (lesson 2026-10-21), reproduced under
   `taskset -c 0,1` with load.
3. Audit AC-1 to AC-16 (the spec has 16, the brief said 14) with a read-only subagent; close each
   gap with a test or leave the spec in place.
4. Red-first proof for every new test, full gate, e2e three times, Codex adversarial review,
   `om-auto-review-pr`.

Re-planned after the audit (step 3) found gaps in AC-1 (no page test opened every agent run in
full), AC-9 (no comparison on the mock run), AC-13 (no page-level highlighter failure) and AC-16
(no page-level stall): added tests for AC-1, AC-9 and AC-16; AC-13's failure clause stays
verified on the component (see Decisions).

## Decisions

- **Real CLI run in Playwright.** `apps/web/e2e/real-capture.spec.ts` writes a suite and a fake
  `claude` under the e2e temporary root and runs `node apps/cli/dist/cli.js --data-dir <e2e>
  benchmark run … --auth api-key --yes --json` with an allowlisted environment (PATH with the fake
  first, a temporary HOME, the planted key as `ANTHROPIC_API_KEY`, TMPDIR). The fake replays the
  recorded `api-key-success.ndjson` stream with the skill name replaced by the demo skill (else
  the adapter stops the run as `artifact-not-loaded`). The command exits 6 (verdict `error`), which
  the test expects. `afterAll` removes the run, its job, the suite (versions and assignment
  cascade) and its fixture row, so later specs see the demo data unchanged.
- **Planted secrets.** A known key without a token shape (`planted-e2e-api-key-…`, found only by
  the Claude Code adapter's known-key search) and a `ghp_` token (core token patterns).
- **AC-11 through a real assertion error.** Case `stalls` asserts `(a+)+$` on `out.txt` written as
  32 `a` and `!`; the pattern time limit (2 s) ends both agent runs as `infrastructure-error`
  with `assertion-error`.
- **AC-16 through a real stalled grammar.** Probing Shiki found that the TypeScript grammar's time
  grows with the nesting depth on every line: 10,000 lines of 25 `{` (260,000 bytes, under the
  256 KiB bound) take about 20 s locally (1,000 lines 0.35 s, 2,000 0.75 s, 4,000 3.5 s), each
  line far under the 500 ms per-line limit. The fake writes it as `deep.ts` in case `secrets`.
  The test asserts the timeout note, no highlighted line, the full plain content, and that
  `/api/health`, requested 300 ms after the page, is answered before the page.
- **AC-13's failure clause stays on the component.** No real input made Shiki fail (probed every
  listed language with long strings, comments, regex literals, whitespace, escapes and deep
  nesting: slow, never a throw). Forcing a failure on a page would need a product test hook. The
  clause is verified by `apps/web/test/syntax-highlight-failure.test.ts` (creation rejects,
  tokenizing throws, `highlightLines` never rejects) and the `HighlightFailed` story; the page
  passes the result to `FileView` unchanged. Ticked with this note in §20; flagged in the PR as a
  decision for the maintainer.
- **NFR-123-01.** `packages/benchmark-engine/test/output-files-timing.test.ts`: 10 generated
  1 MiB text files (exactly `OUTPUT_RUN_MAX_BYTES`), captured on the `agent-error`/`timeout` path
  (own manifest, the most work) with the Claude Code adapter; one warm-up, a forced GC, fastest
  of three captures in **process** CPU time (reads and hashing run on libuv's pool), bound = the
  1 s target, named 60 s timeout. A ratio test (`expectLinearTime`) was not used: the NFR is an
  absolute target, and the measured value is about 12 times under it.
- **AC-9 on the mock run.** `engine.test.ts` runs the bundled mock benchmark (the suite
  `directivebench demo` stores) with and without `onAgentRun` and compares verdict, candidate
  outcome, display status, delta, mean scores, warnings and every agent run's status, score,
  pass, change list and assertion results; `runner.test.ts` pins the stored mock run's verdict,
  delta and display status since commit 77459cb, before capture existed.

## Work performed

1. Worktree `.ai/tmp/spec-123-close` on `test/spec-123-close-acceptance` from `origin/main`
   (8169745); `pnpm install`, `pnpm build`.
2. Prototype of the real run in a scratch data directory (demo, then `benchmark run` with the
   fake): found the `artifact-not-loaded` stop and the exit code 6.
3. Tests: `apps/web/e2e/real-capture.spec.ts` (AC-1, AC-3, AC-11, AC-16), the demo-run AC-1
   test in `apps/web/e2e/agent-run-files.spec.ts`, helpers `shownFileLines`, `storedFileLines`,
   `keptFiles` in `apps/web/e2e/support.ts`, `packages/benchmark-engine/test/output-files-timing.test.ts`
   (NFR-123-01), the AC-9 test in `packages/benchmark-engine/test/engine.test.ts`.
4. Read-only AC audit by a subagent; gaps closed as above.
5. Spec: all 16 acceptance criteria ticked with their tests in §20, status `implemented`, moved
   to `.ai/specs/implemented/`, links fixed (index, ADR-0014, the SPEC-123 run logs, the spec's
   own relative links).
6. Lesson [2026-10-30-real-inputs-beat-stand-ins-in-e2e](../lessons/2026-10-30-real-inputs-beat-stand-ins-in-e2e.md).

## Verification

Red-first (each injected regression reverted; product code unchanged in the branch):

| Test | Injected regression | Result |
| --- | --- | --- |
| NFR-123-01 timing | `[...file.content].sort()` per kept file in `captureOutputFiles` | failed: `expected 1430.517 to be less than 1000`; green: ~85 ms (~82 ms under `taskset -c 0,1` with two `yes`) |
| AC-3 e2e | `merged.length = 0` before `placeCut` (no redaction), CLI rebuilt | AC-3 failed on the stored rows; AC-11 failed on the page showing `api key: planted-e2e-api-key-…` |
| AC-11 e2e | `onAgentRun(record, errorCode === 'assertion-error' ? null : capture)` | failed: 2 of 4 `notes.txt` rows stored; the files page showed the "no files" notice |
| AC-9 unit | capture empties each kept file in the workspace after reading it | failed: verdict `unchanged`, display status `failed` instead of `improved`/`passed` |
| AC-1 e2e (both) | `FileView` drops the last line | both failed (`Expected - 1, Received + 0`) |
| AC-16 e2e | `SYNTAX_HIGHLIGHT_DEADLINE_MS = 120_000` | failed: the page did not answer within the test timeout |
| AC-16 e2e (after Codex round 1) | `highlightTexts` tokenizes on the request thread instead of the worker | failed: the health request hung until the test timeout (`Request context disposed`) |

Gate on the final code (commit `e532123`; later commits change docs only):

| Command | Result |
| --- | --- |
| `pnpm lint && pnpm format:check && pnpm typecheck` | pass |
| `pnpm test` | pass, 7 of 7 tasks, 100% lines, branches, functions and statements in every package |
| `taskset -c 0,1 pnpm test --force` | pass, 7 of 7 tasks (two cores, like the CI runner) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e`, three consecutive runs | 108 passed each time (2.6 min each) |
| `pnpm test:storybook` | pass |
| `apps/web/e2e/real-capture.spec.ts` under `taskset -c 0,1` with two `yes` | 4 passed; AC-16 page answered after 2.8 s, largest gap between health answers 380 ms (bound 2 s) |
| NFR-123-01 timing test alone and under `taskset -c 0,1` with two `yes` | ~87 ms and ~82 ms against the 1 s target |

Review: Codex adversarial review round 1 `needs-attention` (one medium finding: the AC-16 health
check used a fixed sleep and browser timing, so it was racy and did not prove responsiveness
during the stall; fixed by polling `/api/health` on the server's timing for as long as the page is
pending, with a red-first proof); round 2 `approve`, no material findings. `om-auto-review-pr`: see the PR.

Not verified: AC-13's highlighter failure on a page (verified on the component, see Decisions);
the browser-side "no highlighter code" check of AC-12 on the installed tarball (e2e runs the
same `dist` that is packed); macOS (the fake `claude` is POSIX `sh`, the e2e job runs on Linux).
No UI code changed, so no browser QA agent was run.

## Problems and deviations

- The brief named AC-1 to AC-14; the spec has AC-1 to AC-16, all audited.
- `next` augments `ProcessEnv` with a required `NODE_ENV`; the e2e's allowlisted environment is a
  `Record<string, string>` widened to `NodeJS.ProcessEnv`, as `agent-adapters` does.
- The e2e helper maps an empty line's no-break space (drawn to keep its height) back to `''`.

## Lessons recorded

- [2026-10-30-real-inputs-beat-stand-ins-in-e2e](../lessons/2026-10-30-real-inputs-beat-stand-ins-in-e2e.md)

## Follow-ups

- AC-13 on a page would need a way to make the highlighter fail in a built app (a test-only hook);
  the maintainer decides whether the component-level check is enough.
- `react/no-danger` (or an equivalent guard) would make AC-15's "no `dangerouslySetInnerHTML`"
  enforced rather than searched.
