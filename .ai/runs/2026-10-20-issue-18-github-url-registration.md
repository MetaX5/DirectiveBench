---
title: Register a public GitHub repository by URL and scan only its candidate files (issue #18, E01-S04)
date: 2026-10-20
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 18 (feature route; covering specs SPEC-104, SPEC-105, SPEC-201, ADR-0012)
status: completed
branch: feat/issue-18-github-url-registration
specs: [SPEC-104, SPEC-105, SPEC-201, SPEC-102, SPEC-007, SPEC-013, SPEC-014]
---

# Run: Register a public GitHub repository by URL

Source doc: .ai/specs/2026-10-14-repository-management.md
Issue: #18

## Objective

Implement issue #18 (E01-S04) acceptance criteria:

1. `https://github.com/<owner>/<repo>[.git]` of a public repository registers with provider
   `github`, the default branch detected, no credentials asked for or stored.
2. A scan discovers artifacts with the same rules as E01-S02; each occurrence records the commit.
3. A fetch downloads only candidate-path blobs (blob-less shallow partial clone + explicit blob
   fetch by ID, no working tree, no sparse checkout) into `<dataDir>/cache/repos/<id>.git` with
   user-only permissions; nothing beyond artifact files and metadata reaches the database.
4. A URL with embedded credentials is rejected with an explanation; nothing stored or logged.
5. A private or non-existent repository gives "not found or not public", no prompt, nothing stored.
6. No hooks, filters or checkouts run.
7. The default test suite makes no network calls (local bare repository as the remote).

## Plan

Feature route of `om-auto-fix-issue`: the covering specs exist (SPEC-104, SPEC-105 FR-105-05 and
§9.1 updated by #25/PR #36, SPEC-201, ADR-0012), so no spec PR; spec gaps are filled in this PR.

1. `core`: URL parsing/normalisation (`parseRepositoryUrl`, `hostedRepositoryLocationSchema`,
   `looksLikeRepositoryUrl`); refactor `discoverArtifacts` into a listing-based core shared with a
   tree-based `selectCandidateFiles` + `discoverArtifactsInTree`, so hosted scans use exactly the
   walker's rules.
2. `database`: registration payload `{ url }` (normalised only), hosted error codes,
   `registerHostedRepository`, `commitSha` in scan application and result, `LOCAL_PROVIDERS` for
   the FR-104-18 overlap check.
3. `runner`: raw-output git process runner; hardened hosted git (allowlisted env, empty HOME,
   ignored global/system config, one protocol, no credential helper/prompt/redirects/hooks);
   registration via `ls-remote`; scan via bare blob-less shallow clone, `ls-tree`, candidate
   selection, one blob fetch by ID, `cat-file --batch`; cache limit watch; test-only transport.
4. `web`: one field for path or URL; credential URLs rejected without echo; Scan for GitHub.
5. Tests offline (local bare remotes over `file://`, a fake git for unreachable branches),
   Playwright for the web paths, then a manual run against github.com.

## Decisions

- OQ-104-01 (⚠️ decision needed): hosted validation runs as the same `repository-registration`
  runner job (short lane); the web only parses and enqueues. Recorded in SPEC-104 §9 and §18.
- ⚠️ No `packages/git-providers` yet: hosted git lives in `packages/runner/src/hosted-git.ts` and
  `hosted-repository.ts` (the only consumer is the runner; extraction is cheap when GitLab
  arrives). Avoids a speculative package (SPEC-014).
- ⚠️ Hosted locations are normalised to lower case (`https://github.com/acme/skills`), because
  GitHub owner and repository names are case-insensitive; the display name keeps the typed case.
- ⚠️ Cache limit 500 MiB per repository as a constant (SPEC-105 §12 Assumption), not configurable.
- A rejected URL that contains `@` goes back to the form without its input (only the reason), so
  a credential never reaches the browser history or a log; other rejected URLs are echoed.
- The test transport (`HostedGitTransport` with `protocol: 'file'`) is a `LocalRunner` option in
  code only; production always uses HTTPS. Tests never reach the network.
- `--template=` on clone (no sample hooks in the cache) and `credential.interactive=false`,
  `http.followRedirects=false` (SPEC-201 §5.1) were added to the SPEC-105 §9.1 invocation.

## Work performed

1. `core`: `hosted-repository.ts`; `discovery.ts` refactored (`planCandidates`, `discoverListing`)
   with `selectCandidateFiles` and `discoverArtifactsInTree` (contents map, sizes for unloaded
   blobs).
2. `database`: `jobs.ts` (payload union, codes, `commitSha`, provider lists, `input`/`source` in
   `RepositoryRegistration`), `catalog.ts` (`registerHostedRepository`), `artifacts.ts`
   (`commitSha`).
3. `runner`: `git-process.ts`, `hosted-git.ts`, `hosted-repository.ts`; `repository-scan.ts`
   (`storeScanResults` shared with hosted scans); `runner.ts` dispatch by payload/provider,
   `cacheDir`, `hostedGitTransport`, `hostedGitLimits` options; CLI passes `layout.cache`.
4. `web`: `actions.ts`, `lib/repositories.ts`, `app/repositories/page.tsx`; Playwright
   "GitHub repositories by URL".
5. Specs SPEC-104 (§8 codes, §9 flow, §13, §16, §18 OQ-104-01, Phase 3, §20), SPEC-105 (§9.1
   invocation, §16, §20), SPEC-201 (§13), ADR-0012 validation note, README status.

## Verification

- `pnpm format:check` — pass. `pnpm lint` — pass. `pnpm typecheck` — 7/7 tasks.
- `pnpm test` — all packages pass at 100% coverage (core 238, database 116, runner 185, web 98,
  cli 75, benchmark-engine 110, agent-adapters 34 tests); run 4 times in a row after making the
  timing-dependent coverage deterministic (see Problems).
- `pnpm build` — pass. `pnpm verify:pack` — "Packaging verification passed".
- `pnpm test:e2e` — 31 passed (4 new: credential URL rejected and found nowhere, unsupported URL,
  seeded GitHub repository listed with Scan, seeded "not found or not public").
- Manual, built CLI (`node apps/cli/dist/cli.js --data-dir <tmp> serve`), driven with Playwright
  against **github.com (network available)**:
  - `https://github.com/anthropics/skills` → "Registered anthropics/skills (GitHub, …)", branch
    `main`; Scan → 445 files listed, 20 artifacts, commit `dbd4588f9e10` on every occurrence and
    `last_commit_sha`; rescan → 0 new versions. Cache `<data>/cache/repos/<id>.git` mode 700
    (also `cache`, `cache/repos`, empty `cache/git-home`), bare layout only (`HEAD config objects
    packed-refs refs shallow`), 324 blobs = the candidate files; README.md,
    `.claude-plugin/marketplace.json`, `spec/…` and other non-candidates absent
    (`cat-file --batch-all-objects --batch-check`); 3.8 MB on disk.
  - `https://user:ghp_…@github.com/anthropics/skills` → credential message, page URL
    `?urlError=credentials-in-url`; no `ghp_`/`user:` in the database or `logs/`.
  - `https://github.com/MetaX5/this-repository-does-not-exist-18` → first run showed "git failed:
    unable to get password from user" (bug, fixed, see Problems); after the fix "The repository
    was not found or is not public. …", nothing stored; no prompt appeared (the job finished on its
    own, non-interactive).
- Manual, test transport: a scratch Vitest script ran `LocalRunner` with `fileTransport` against a
  local bare remote: registration `github`/`main`, scan of 5 files → 2 artifacts with the commit;
  the cache held 3 blobs (SKILL.md, notes.md, AGENTS.md), not `docs/big.bin` or `README.md`.

Not verified: Windows and macOS (CI runs Ubuntu only); a real proxy; a GitHub redirect (github.com served
a renamed repository directly with redirects disabled, so the 3xx mapping is tested only with a
recorded message); git versions between 2.44 and 2.53; a repository above the 500 MiB cache limit
against github.com (tested locally only).

## Problems and deviations

- Real github.com answered a missing repository with `fatal: unable to get password from user`
  (because of `credential.interactive=false`), which the patterns built from the familiar
  "could not read Username … terminal prompts disabled" missed; the offline tests could not show
  it. Added the pattern and the recorded message; lesson recorded.
- The "skips submodules" test passed without a submodule (`git add -A` dropped the gitlink);
  found by the coverage gate; fixture fixed and asserted.
- Coverage of the runner was intermittently 99.86% under the parallel `pnpm test`: the
  cache-limit and blob-fetch-timeout branches were reached by real git only with lucky timing
  (and a fake git starting slower than the 1 s poll). Added deterministic fake-git cases and a
  `lstat` race case; lesson updated.
- `runner-lanes.test.ts` assumed the scan starts in the same tick as the claim; the runner now
  reads the repository's provider first, so the test waits for the scan to start.
- Deviations from SPEC-105 (recorded in §20): no step 0 / fast path (rescans are #19), no retry
  after a blob still missing, cache limit not configurable, scan job named `repository-scan`.

## Lessons recorded

- [2026-10-20-record-git-errors-of-the-exact-invocation.md](../lessons/2026-10-20-record-git-errors-of-the-exact-invocation.md) (new)
- [2026-10-15-deterministic-full-coverage.md](../lessons/2026-10-15-deterministic-full-coverage.md) (updated)
- [2026-10-14-testing-processes-and-http.md](../lessons/2026-10-14-testing-processes-and-http.md) (updated)

## Follow-ups

- Rescan semantics with step 0/fast path and changed-file detection (#19).
- Branch picker and `ls-remote --heads`; default branch refresh on re-registration.
- Delete a hosted cache when repository removal exists (FR-104-15, FR-105-19).
- `directivebench doctor` reporting the git version needed for hosted repositories (NFR-104-03).
- Decide whether to extract `packages/git-providers` when GitLab or credentials arrive.
