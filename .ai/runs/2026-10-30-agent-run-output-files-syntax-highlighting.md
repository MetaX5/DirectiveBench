---
title: SPEC-123 Phase 3a, syntax highlighting in a terminable worker on the files page
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 3a only, approved with Phase 4 on 2026-10-30), issue #152
status: completed
branch: feat/agent-run-output-files-syntax-highlighting
specs: [SPEC-123, SPEC-014, SPEC-004, SPEC-122]
---

# Run: SPEC-123 Phase 3a, syntax highlighting

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** SPEC-123 §21 "Phase 3a: Syntax highlighting" (FR-123-70 to FR-123-78,
NFR-123-07, AC-12 to AC-16, ADR-0014) on the existing files page
`/results/[id]/agent-runs/[agentRunId]` (Phase 3, #162). The library
`apps/web/lib/syntax-highlight.ts`, the `--syntax-*` tokens and the components' optional
`highlight` prop already exist (#155). New here: the terminable `node:worker_threads` worker with
the aggregate `SYNTAX_HIGHLIGHT_DEADLINE_MS` deadline per page render, the job queue, the
timeout note, the page wiring, the packaging proof and the page tests. Not in scope: the compare
page (Phase 4, built by another agent in parallel) and blind review (Phase 5). The PR uses
`Refs #152`.

## Plan

Goal: the files page shows server-side syntax colours computed off the request thread with a
hard 2 s deadline per page render, from the dev build and from the installed tarball.

Non-goals: building the compare page (Phase 4; its highlighting was wired here after it merged), new UI components or
variants, changes to the `--syntax-*` colours.

1. Split `lib/syntax-highlight.ts`: `syntax-highlight-common.ts` (types, limits, language map,
   no Shiki), `syntax-highlight-shiki.ts` (the existing Shiki tokenizer, unchanged behaviour,
   now `tokenizeText`), `syntax-highlight-worker.ts` (worker entry) and the server-only
   `syntax-highlight.ts` (worker pool with deadline and queue, `highlightTexts`,
   `highlightLines`). `HighlightResult` gains reason `timeout`; `syntaxHighlightNotice` its
   sentence.
2. Bundle the worker: `new Worker(new URL('./syntax-highlight-worker.ts', import.meta.url))`,
   checked on the `next build` output (a `[worker thread]` server chunk with Shiki bundled, no
   Shiki in `static/chunks`).
3. Unit tests to 100%: real-thread worker, stalled synchronous loop terminated at the deadline
   with an event-loop delay probe, many slow lines, worker recreated, full queue, crash, exit,
   failed start, stale events, the worker entry module.
4. Wire the files page; `FileView` story and docs for the timeout note.
5. Page tests: highlighted demo file and seeded code files, too-large and unknown-extension
   notes, hostile markup still text, no Shiki in the browser (AC-12, AC-13, AC-15);
   `ui-contrast.spec.ts` measures every `--syntax-*` colour on the page against the code surface
   and the D11 and D12 tints in both themes (AC-14).
6. `verify:pack` renders a highlighted file from the installed tarball and checks the runtime
   dependencies (FR-123-77).
7. Gate, real-app proof, browser QA agent, Codex adversarial review, om-auto-review-pr.

## Decisions

- **The deadline counts from submission.** `SYNTAX_HIGHLIGHT_DEADLINE_MS` starts when a page
  render submits its job, so it covers the wait behind another job, the worker's start,
  highlighter creation and both texts: a page never waits more than about 2 s for colours
  (FR-123-74 "never delay the page beyond the bound"). Jobs run in submission order with one
  deadline, so the job whose time runs out is always the running one; its expiry terminates the
  worker and ends every job of that worker (running and waiting) as `timeout`, as FR-123-78
  says. A job that finds 8 waiting is answered `timeout` at once.
- **Module split for the worker.** The worker cannot import `server-only` (it is not a React
  Server Component context), so the Shiki code moved to `syntax-highlight-shiki.ts`, reachable
  only from the worker entry, which only the server-only `syntax-highlight.ts` references.
  Pages and components still import `@/lib/syntax-highlight`.
- **`.ts` import specifiers in the worker chain** (`allowImportingTsExtensions` in
  `apps/web/tsconfig.json`): Next.js bundles the entry; in unit tests Node 24 runs the same
  unbuilt entry in a real thread with type stripping, so the tests exercise the real worker.
- **A late answer is a timeout.** The pool also checks a job's monotonic expiry when the
  worker's answer arrives, because a busy request thread can run the message before the overdue
  timer (Codex adversarial review round 1).
- **Worker failures are `failed`.** A worker that cannot start, throws or exits ends its jobs as
  `failed` (the existing note) and is replaced lazily; the error is logged by name only.

## Progress

PR: #166

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Worker and library

- [x] 1.1 Split the library and add the worker pool with deadline and queue — dcf78b0
- [x] 1.2 Unit tests for the worker, deadline and queue — dcf78b0, 4750200

### Phase 2: Page and tests

- [x] 2.1 Wire the files page, story and docs for the timeout note — ce2a3fa
- [x] 2.2 Page tests and syntax contrast on the page — 201afc2
- [x] 2.3 verify:pack renders a highlighted file from the tarball — 3aa430d, 3876b39

### Phase 3: Verification

- [x] 3.1 Full gate, real-app proof, browser QA, Codex review, om-auto-review-pr

## Work performed

1. Split `lib/syntax-highlight.ts` into `syntax-highlight-common.ts`, `syntax-highlight-shiki.ts`
   (`tokenizeText`, the former in-process highlighter), `syntax-highlight-worker.ts` (entry)
   and the server-only pool `createHighlightWorkerPool`, `highlightTexts`, `highlightLines`
   with `SYNTAX_HIGHLIGHT_DEADLINE_MS` (2,000) and `SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS` (8);
   `HighlightResult` reason `timeout` and its note (dcf78b0).
2. Files page highlights the selected file; `FileView` story `HighlightTimedOut`; FileView and
   SideBySideDiff docs (ce2a3fa).
3. Seeded code run (`run_e2e123_code`), page tests and the on-page AC-14 contrast test
   (201afc2); `verify:pack` checks (3aa430d, 3876b39); ADR-0014 as-built note; lesson.
4. Codex round 1 fix: late answers count as timeouts (4750200).

## Verification

| Command / check | Result |
| --- | --- |
| `pnpm lint`, `pnpm format:check`, `pnpm typecheck` | pass |
| `pnpm test` | 7/7 packages, 100% statements, branches, functions and lines (web: 1,130 statements, 20 files, 426 tests) |
| `pnpm build` | pass; `.next/server/chunks/ssr/[worker thread]-apps_web_lib_syntax-highlight-worker_ts_*.js` with Shiki bundled; no Shiki grammar or `tokenizeTimeLimit` in `.next/static/chunks` |
| `pnpm verify:pack` | pass, including "the files page shows a highlighted file (server-side tokens)" and "runtime dependencies are only next, react and react-dom" |
| `pnpm test:e2e` | 76 passed (one run had 1 unrelated failure in `home.spec.ts` navigation under load from a parallel agent; the full rerun passed 76/76) |
| `pnpm test:storybook` | 68 files, 300 tests passed |
| Red first | removing `worker.terminate()` fails 4 worker tests (stalled loop, many slow lines, queue wait, crash); removing the late-answer check fails its regression test |
| Real app | built CLI after `directivebench demo` plus the e2e seed: `src/parse-age.js` and the seeded code files coloured, 20 concurrent page requests all highlighted with `/api/health` answering in 56 ms; `next dev` also colours the page |
| Browser QA agent (Claude in Chrome) | all 8 checks pass: colours and contrast in both themes (lowest 5.51), notes, hostile markup as text, keyboard, 320 px (iframe), console clean, no highlighter code in the browser, invalid `?path=` gives 404 |
| Codex adversarial review | round 1 needs-attention (late answer), fixed; round 2 no material findings; round 3 approve; round 4 (CI-fix delta) approve |
| `om-auto-review-pr` | COMMENT reviews (own PR): approve; one e2e nit fixed, two minors documented |
| CI on `8200972` | all checks green (Linux and macOS unit at 100%, build and package, integration, storybook, CodeQL) |

**After Phase 4 (#165) merged** (orchestrator request): `origin/main` merged into the branch
(conflicts in SPEC-123 §20 and `.ai/lessons.md` resolved keeping both sides), and the compare
page `/results/[id]/compare` now highlights both `SideBySideDiff` sides with one
`highlightTexts` job per page render in the language of the compared path (FR-123-76). The
compare seed's `src/render.php` became real PHP (same diff shape: 1 line removed, 2 added). New
e2e: both sides tokenized, filler rows not, tints and markers kept, the same comment coloured on
both sides, the hostile Markdown side highlighted and still text; `ui-contrast` measures every
token on the real removed and added rows of the compare page in both themes. Gate on the merge:
`pnpm lint`, `format:check`, `typecheck` pass; `pnpm test` 7/7 at 100%; `pnpm build`;
`pnpm verify:pack` passed; `pnpm test:e2e` 90 passed; `pnpm test:storybook` 304 passed. Real
app (built CLI, fresh `directivebench demo` plus the compare seed): the seeded and the demo
compare pages render highlighted rows with their `removed`, `added` and `filler` tones and no
highlighting note. A second browser QA agent (Claude in Chrome) on the compare page: all 7
checks pass (colours in both themes, lowest token contrast on a real tinted row 5.10 light and
5.89 dark, 4.82 with every token class injected into a removed row; diff rows, markers, labels
and alignment unchanged; hostile Markdown as text; keyboard; 320 px in an iframe; clean
console; no highlighter code in the browser; no notes). Two nits, no confirmed defect: the
pre-existing no-break space on empty lines, and the PHP grammar colouring `$label` inside a
call as a function token. Codex round 5 on the merge: approve. CI on `60015b6`: all green.

Not verified: AC-16 on a real page with a stalled grammar (no way to plant one without a test
hook; the stall is proved with stand-in workers in unit tests); the D12 neutral tint on a real
page (only blind review, Phase 5, uses it; measured with the tint class applied on the files
page); the browser QA agent could not
resize the Chrome window and checked 320 px in an iframe; Windows and macOS were not run
locally (CI covers macOS unit tests).

## Problems and deviations

- Turbopack also copies the worker entry's source to `.next/static/media/syntax-highlight-worker.<hash>.ts`
  (an unreferenced asset, 30 lines, no highlighter code or grammar); it ships in the tarball and
  is served at `/_next/static/media/`. The browser never requests it. Recorded in the lesson.
- FR-123-70 names `syntax-highlight.ts` as where highlighting runs; the Shiki calls are in
  `syntax-highlight-shiki.ts`, reached only through the worker that the server-only
  `syntax-highlight.ts` starts (ADR-0014 as-built note, SPEC-123 §20).
- The deadline counts from submission, including the queue wait (see Decisions).
- `tsconfig` gains `allowImportingTsExtensions` for the worker chain.

- CI (Linux unit job) failed the first real-thread test: the unbuilt worker's cold start
  (type stripping, grammar modules, highlighter creation) took over 2 s on the loaded runner,
  so the deadline correctly returned `timeout`. The real-thread tests now freeze the deadline
  clock (`vi.useFakeTimers` for `setTimeout`, `clearTimeout`, `performance`; the pool reads the
  global `performance`), and still pass with the deadline set to 1 ms; the deadline itself
  stays covered by the stand-in workers. The macOS unit job of that run failed in the untouched
  `apps/cli/test/runner-acquired.test.ts` (timing), not in this change.

## Lessons recorded

- [2026-10-30-server-worker-threads-in-next](../lessons/2026-10-30-server-worker-threads-in-next.md)

## Follow-ups

- Phase 5 (blind review) should call `highlightTexts` for both sides from the start (§21 Phase 3a step 4).
- A cold highlighter can take over 2 s on a slow or loaded machine, so the first file view
  after a server start may show the timeout note (by spec, FR-123-78 creates the worker
  lazily). If that shows up in use, consider starting the worker when the server starts.
- Browser QA finding A (predates this change): an empty line renders a no-break space, so
  copying a file with blank lines gives a space per blank line (`code-lines.tsx`).
