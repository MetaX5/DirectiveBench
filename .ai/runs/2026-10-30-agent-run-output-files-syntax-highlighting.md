---
title: SPEC-123 Phase 3a, syntax highlighting in a terminable worker on the files page
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 3a only, approved with Phase 4 on 2026-10-30), issue #152
status: in-progress
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

Non-goals: the compare page and its `SideBySideDiff` wiring (Phase 4), new UI components or
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
- **Worker failures are `failed`.** A worker that cannot start, throws or exits ends its jobs as
  `failed` (the existing note) and is replaced lazily; the error is logged by name only.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Worker and library

- [ ] 1.1 Split the library and add the worker pool with deadline and queue
- [ ] 1.2 Unit tests for the worker, deadline and queue

### Phase 2: Page and tests

- [ ] 2.1 Wire the files page, story and docs for the timeout note
- [ ] 2.2 Page tests and syntax contrast on the page
- [ ] 2.3 verify:pack renders a highlighted file from the tarball

### Phase 3: Verification

- [ ] 3.1 Full gate, real-app proof, browser QA, Codex review, om-auto-review-pr

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
