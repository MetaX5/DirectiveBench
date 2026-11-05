---
title: Classify git's "repository not found" (HTTP 404) as not found or not public (issue #81)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue chain)
trigger: maintainer-approved fix of issue #81
status: in-progress
branch: fix/issue-81-hosted-git-404-not-found
specs: [SPEC-104, SPEC-105]
---

# Run: Classify git's HTTP 404 "repository not found" as not found or not public

## Objective

Issue #81: a remote answering 404 must give the "not found or not public" message
(`auth-required`) at hosted registration and store nothing. Classification keys on git's message
for the exact hardened invocation; tests use a loopback server or recorded stderr, no network.

## Plan

om-verify-in-repo → om-root-cause → om-fix → om-open-pr --handoff → om-auto-review-pr --autofix
(review submitted as COMMENT). Scope: `packages/runner/src/hosted-git.ts` and tests; no UI change,
no edit of `runner.ts` (issue #70 in parallel) or `packages/core`/`packages/database` (SPEC-124).

## Decisions

- One anchored pattern, `/^fatal: repository '.*' not found$/m`, added to `NOT_FOUND_PATTERNS`. It
  keys on git's own line (http.c, missing target) rather than on host text, and anchoring keeps a
  server's `remote:` output from reaching it through this pattern. The existing
  `NOT_FOUND_OR_NOT_PUBLIC` message is reused; no contract change.
- The loopback test runs over HTTPS (the production protocol) by extending the existing TLS test
  server with a configurable status, instead of allowing `http` in the transport.

## Work performed

1. Triage: issue open, unclaimed, no PR or commit referencing it; reproduced with a loopback
   server answering 404.
2. Recorded stderr with the exact hardened argv and environment (git 2.53.0, libcurl 8.18.0,
   loopback HTTPS server with a self-signed CA through `GIT_SSL_CAINFO`, answering 404 to every
   request). `ls-remote --symref -- <url> HEAD`, the production `clone` and `fetch` all print:
   `fatal: repository 'https://127.0.0.1:<port>/acme/skills.git/' not found` (clone preceded by
   `Cloning into bare repository '<cache>'...`), exit 128. No `remote:` line and no
   `The requested URL returned error: 404`.
3. Root cause: `/Repository not found/i` matched only github.com's `remote: Repository not found.`
   line; git's own message has the URL between the words, so a bare 404 fell through to
   `git-failed` ("git failed: repository '…' not found").
4. Fix in `packages/runner/src/hosted-git.ts`; tests in `hosted-git.test.ts` (two recorded
   stderr rows) and `hosted-repository-tls.test.ts` (end-to-end `registerHostedUrl` against a
   loopback 404, asserts `auth-required` + message, requests reached the server, 0 repositories
   stored). SPEC-104 implementation status note; lesson follow-up.

## Verification

- Red first: without the source change the 3 new tests fail (`git-failed`, "git failed:
  repository '…' not found"); with it they pass.
- `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` pass; `pnpm test` pass (runner 238
  tests, all packages green, 100% coverage threshold met); `pnpm build` pass; `pnpm verify:pack`
  pass.
- Not verified: a real proxy or non-GitHub host answering 404 (no network in tests; the built CLI
  only accepts github.com URLs, which answer 401, so the CLI cannot be pointed at a 404 host
  without the test transport). git versions other than 2.53 were not recorded.

## Problems and deviations

- A first loopback probe without `-u` read an empty port from Python's buffered output; harmless.

## Lessons recorded

- Follow-up added to `.ai/lessons/2026-10-20-record-git-errors-of-the-exact-invocation.md`
  (index entry updated).

## Follow-ups

- For a failed `git clone` that falls through to `git-failed`, the shown first line is
  `Cloning into bare repository '<cache>'...` rather than the error (pre-existing; `firstLine`
  skips only `warning:` lines). Not changed here.
