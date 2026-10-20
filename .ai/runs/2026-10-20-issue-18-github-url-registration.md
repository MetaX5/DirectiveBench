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
- `pnpm test` — all packages pass at 100% coverage (core 238, database 116, runner 185 — 187 after the review fixes — web 98,
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

## Review rounds

- Independent review at `6b08c4f` (security focus, `om-code-review`, offline run under
  `unshare -rn` plus read-only probes of github.com and a local 301 server): REQUEST CHANGES,
  2 majors, 6 minors, nits. Fixed:
  - Major: a failed blob fetch (incl. `cache-limit-exceeded`) left the cache on disk — git-step
    failures after the snapshot now delete it (regression assertion in the blob-limit test).
  - Major: an empty repository or a renamed default branch could never be scanned, and
    "register again" did nothing — `registerHostedRepository` now refreshes the default branch
    on conflict (regression test: empty → push → register again → scan).
  - Minor: a token in a query or fragment was echoed — inputs with `@`, `?` or `#` go back
    without the input. Minor: absolute cache paths in git messages are replaced by `<cache>`.
    Minor: HTTP 403 is `unreachable` (rate limits), not "not found or not public".
    Nits: a late watch failure after exit is ignored; a failed size check reports `git-failed`.
  - Documented instead of changed: the hosted per-scan byte pre-check counts binary candidates,
    unusual modes fail the scan, a hosted registration can hold the short lane ~35 s, custom CA
    certificates are not forwarded (SPEC-104/105 §20).
  - Gate after the fixes: format, lint, typecheck, test (100%), build, verify:pack, e2e 31 — pass.

- Independent re-review at `d99a2a2`: APPROVE (no blocker/major), 4 minors, 4 nits. Fixed: the
  late-watch test now spies on `process.kill` (proved to fail without the guard); `result.error`
  gets the same `<cache>` replacement as stderr; cache deletion asserted after a failed listing and
  a failed read; a re-registration whose remote reports no default branch keeps the known one
  (`coalesce`); SPEC-104 §9 wording (`@`, `?`, `#`); run log test count. Not changed: the
  "already registered" wording after a branch refresh, `error` before `timedOut` in `abnormal()`,
  and exceptions from `prepare()`/`rm`/`chmod` reaching the generic job error (same as local
  scans; follow-up). Full gate passed again.

## Codex review finding and fix

- Finding (Codex adversarial review at `a8bea74`, confirmed): `GIT_CONFIG_NOSYSTEM=1` and
  `GIT_CONFIG_GLOBAL=/dev/null` do not stop git from discovering a repository from its working
  directory. With `--data-dir` inside a git work tree, `ls-remote` (cwd `<cache>/git-home`) loaded
  the enclosing `.git/config`: `url.*.insteadOf` (also through `include.path`), `http.extraHeader`,
  `http.sslVerify=false`, `http.proxy`, `credential.helper` — against FR-104-12/D06 and "never
  disable TLS verification". Audit of every hosted invocation (probe with a broken config line in
  the enclosing `.git/config` as a tripwire, git 2.53): `version` and `clone` do not discover;
  `ls-remote` does; `fetch`, `rev-parse`, `ls-tree`, `cat-file` and the blob fetch run in the bare
  cache and find it first — but when the cache is broken (e.g. `HEAD` missing) git walks up, and
  `fetch origin` fetched the enclosing repository's `origin` into the enclosing repository, after
  which `rev-parse` read its commit. The cache's own config is written only by DirectiveBench's
  `clone` (remote URL, promisor settings); fetched content cannot change it. `GIT_CONFIG_PARAMETERS`
  / `GIT_CONFIG_COUNT` were already absent (allowlisted environment, existing test).
- Fix (`packages/runner/src/hosted-git.ts`): git never discovers a repository. Every step names its
  repository: steps on the cache pass `gitDir`, which sets `GIT_DIR` (and the working directory);
  steps without one (`version`, `ls-remote`, `clone`) run in the empty `HOME`. Every step also gets
  `GIT_CEILING_DIRECTORIES` = the parent of `HOME` (`<dataDir>/cache`), so discovery could look at
  `HOME` only. Chosen over a nonexistent `GIT_DIR` for repository-less steps because `clone`
  overrides `GIT_DIR` itself and the ceiling is git's documented "stop here" mechanism; `GIT_DIR` on
  cache steps makes a broken cache fail ("not a git repository: '<cache>/…'", then the existing
  fresh-clone retry) instead of falling through. `parentDir` (clone cwd) was removed.
- Regression test (`hosted-repository.test.ts`, "reads no configuration of a git repository that
  encloses the data directory"): data directory inside a git work tree whose config has an
  `include.path` with an `insteadOf` to a different bare repository (other content, other default
  branch), `http.extraHeader`, `http.sslVerify=false`, `http.proxy`, `credential.helper`,
  `remote.origin` = the other repository. Armed first (plain `git config --show-origin --list`
  below the data dir shows all of it). Registration gets `main` (not `evil`), clone, rescan fetch,
  blob fetch, reads and the fetch into a broken cache all read the right repository, the enclosing
  repository gets no refs, no marker; finally `config --show-origin --list` with the hardened
  argv and environment shows only `command line:` (in `HOME`) and `command line:` + the cache's
  `config` (with `gitDir`). On the old code the test failed (`expected 'evil' to be 'main'`).
  `buildHostedGitEnv` unit test asserts `GIT_CEILING_DIRECTORIES` and `GIT_DIR`.
- Gate: `pnpm format:check`, `lint`, `typecheck`, `test` (runner 189 tests, all packages 100%),
  `build`, `verify:pack` ("Packaging verification passed"), `test:e2e` (31 passed) — pass.
- Manual, built CLI against github.com: `--data-dir` inside a temporary git repository whose
  `.git/config` has `url."https://gitlab.com/".insteadOf=https://github.com/`, an
  `http.extraHeader` with a fake `ghp_` token, `http.sslVerify=false` and `http.proxy=127.0.0.1:9`
  (armed: plain `git ls-remote` from the data dir went to gitlab.com through the dead proxy and
  failed). Registered `https://github.com/anthropics/skills` through the UI: provider `github`,
  branch `main`; Scan: 445 files, 20 artifacts, commit `dbd4588f9e10`, `sync_status` ok; the
  enclosing repository has no refs; the cache config holds only `core` and `remote.origin`
  (github.com URL, promisor); no `gitlab`, `ghp_` or proxy value in `logs/` or the cache config.
- Not verified: Windows (`GIT_CEILING_DIRECTORIES`/`GIT_DIR` with drive-letter paths) and macOS;
  git versions other than 2.53.
- Independent re-review at `3d678f8` (security focus, `om-code-review`, real-git probes and source
  mutations): REQUEST CHANGES, 1 major, 1 nit. Fixed:
  - Major: `GIT_CEILING_DIRECTORIES` is split on the path delimiter, so a data directory path with
    `:` (`;` on Windows) inside a hostile work tree let `ls-remote` read the enclosing config again
    (reproduced by the reviewer). `prepare()` now refuses such a cache path before running git
    (`git-failed`, message without the path); test with `a:b` in the path for registration and scan.
  - Nit: the regression test now also proves `GIT_DIR` on its own: with the ceiling removed, the
    hardened `config --list` in a broken cache shows nothing of the enclosing repository (without
    `GIT_DIR` it lists the enclosing `.git/config`).
- Lesson: [2026-10-20-git-config-isolation-needs-no-discovery.md](../lessons/2026-10-20-git-config-isolation-needs-no-discovery.md).

## Codex review round 2

- Finding (Codex adversarial review round 2 at `c26ee6b`, confirmed): the "no echo of input with
  `@`, `?` or `#`" rule lived only in `registerUrl`, which runs only when `looksLikeRepositoryUrl`
  matches. Malformed URLs (`https:/github.com/acme/repo?access_token=…`, `https:github.com/…`,
  `http//user:tok@github.com/…`, `HTTPS:\\github.com…?token=…`, `github.com/acme/repo?token=…`)
  fell through to path validation and were echoed verbatim in `/repositories?path=…` — browser
  history and request logs (FR-104-05).
- Rule chosen: guard at the sink, by content. Both branches return to the form through one helper,
  `returnToForm` (`apps/web/lib/actions.ts`), which echoes the input only when
  `mayCarryCredentials` (`apps/web/lib/repositories.ts`) is false: no `@`, `?`, `#` and no
  `%40`/`%3F`/`%23`. Every way to put a secret into a URL (user info, query, fragment) needs one of
  them, whether or not the URL is well-formed; scp-like `user@host:` is caught by `@`. Otherwise
  only a reason code travels (`?urlError=<code>`); the path branch uses the new `not-echoed` code
  with a fixed message ("not a valid local path or GitHub URL … not shown again because it
  contains @, ? or #…"). Not chosen: widening `looksLikeRepositoryUrl` to scheme-like prefixes —
  WHATWG `new URL` silently repairs `https:/` and `HTTPS:\\`, so it would change parsing
  semantics in `core` and still leave the guard tied to the classifier.
- Page: `/repositories?path=` with such characters (hand-made or an old history entry) still shows
  the re-validated, fixed error but is not pre-filled into the field.
- Trade-offs: a valid local path containing `@`, `?` or `#` registers exactly as before (it is a
  path; unit test). An invalid one (relative, too long, NUL) is no longer echoed and gets the
  generic `not-echoed` message instead of the specific path message — not echoing was chosen over
  echoing. The path-branch echo is now trimmed (the field error is computed from the trimmed
  value anyway).
- Tests: `actions.test.ts` "never echoes a malformed URL that may carry a token, whichever branch
  rejects it" (10 variants incl. percent-encoded and scp-like with a token; failed on the old
  code with `?path=https%3A%2Fgithub.com…ghp_…`), "still registers a valid local path that
  contains @, ? or #"; `repositories.test.ts` `mayCarryCredentials` and the `not-echoed` message;
  e2e "a malformed URL with a token is rejected without echoing it anywhere" (page URL, field,
  page content, no job; a hand-made `?path=` with a token is not pre-filled).
- Gate: `pnpm format:check`, `lint`, `typecheck`, `test` (web 143 tests, all packages 100%),
  `build`, `verify:pack` ("Packaging verification passed"), `test:e2e` (36 passed) — pass.
- Manual, built CLI (`node apps/cli/dist/cli.js --data-dir <tmp> serve`), three malformed
  URLs with a fake `ghp_` token through the form: each landed on `?urlError=not-echoed` with the
  fixed message and an empty field; the token was in none of the 93 browser requests, not in the
  page, `logs/web.log`, the database (no jobs) or any file of the data directory.
- Lesson: [2026-10-20-guard-secrets-at-the-sink.md](../lessons/2026-10-20-guard-secrets-at-the-sink.md).

## Lessons recorded

- [2026-10-20-guard-secrets-at-the-sink.md](../lessons/2026-10-20-guard-secrets-at-the-sink.md) (new)
- [2026-10-20-record-git-errors-of-the-exact-invocation.md](../lessons/2026-10-20-record-git-errors-of-the-exact-invocation.md) (new)
- [2026-10-20-git-config-isolation-needs-no-discovery.md](../lessons/2026-10-20-git-config-isolation-needs-no-discovery.md) (new)
- [2026-10-15-deterministic-full-coverage.md](../lessons/2026-10-15-deterministic-full-coverage.md) (updated)
- [2026-10-14-testing-processes-and-http.md](../lessons/2026-10-14-testing-processes-and-http.md) (updated)

## Follow-ups

- Rescan semantics with step 0/fast path and changed-file detection (#19).
- Branch picker and `ls-remote --heads`; default branch refresh on re-registration.
- Delete a hosted cache when repository removal exists (FR-104-15, FR-105-19).
- `directivebench doctor` reporting the git version needed for hosted repositories (NFR-104-03).
- Decide whether to extract `packages/git-providers` when GitLab or credentials arrive.
