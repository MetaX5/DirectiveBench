---
title: Resolve the documented deviations of the hosted GitHub fetch (issue #61)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: issue #61 (follow-up of PR #51), om-auto-fix-issue
status: completed
branch: fix/issue-61-hosted-fetch-deviations
specs: [SPEC-104, SPEC-105, SPEC-201]
---

# Run: Resolve the documented deviations of the hosted GitHub fetch

## Objective

Each deviation of the hosted fetch recorded by PR #51 is either fixed with a regression test or
recorded in SPEC-105 as intended behaviour with its reason:

1. Binary candidate files count toward the per-scan byte budget before they are read.
2. A tree entry with an unusual file mode fails the whole scan instead of being skipped.
3. A hosted registration can hold the short-job runner slot for about 35 s.
4. Custom CA certificates are not forwarded to git, so a TLS-intercepting proxy fails (TLS
   verification must stay on).

Plus two nits: SPEC-104 FR-104-05 lists `%25` and the fullwidth ＠？＃; the `actions.ts` comment
calling `//srv/share` "a UNC path" is wrong on POSIX.

## Plan

1. Item 1: read the step 5 blobs in bounded batches, drop binary blobs right after reading
   (keeping only their size), count only text bytes toward `maxScanBytes`; core's
   `discoverArtifactsInTree` accepts a "binary, size N" entry so discovery applies exactly the
   walker's rules (too-large first, then binary).
2. Item 2: check what `git ls-tree` really prints for legacy modes; fix or specify.
3. Item 3: specify (bounded by named timeouts).
4. Item 4: forward only an explicit, canonicalised CA bundle file (`GIT_SSL_CAINFO` of the runner
   environment), fail closed otherwise; nothing else TLS-related; loopback HTTPS test.
5. Nits, specs, lessons, gate, real CLI check, PR, independent security review.

No re-planning was needed; item 2 turned from "fix" into "specify" once git's behaviour was
measured (below).

## Decisions

- **Item 1 — fixed.** `readCandidateBlobs` (`packages/runner/src/hosted-repository.ts`) reads the
  loadable blobs in batches of at most `HOSTED_READ_BATCH_BYTES` (32 MiB, override
  `readBatchBytes` for tests like the other limits), keeps a binary blob (`isBinary`) only as
  `{ binary: true, size }` (`BinaryTreeFile`, new in `core`) and counts each text blob once
  against `maxScanBytes`. In `discoverArtifactsInTree` a `BinaryTreeFile` is checked against the
  limit of its role first and is then seen as a one-NUL-byte stand-in, so discovery skips it
  (supporting file) or reports `binary-primary` exactly as the walker does. Text above the budget
  still fails the scan before discovery (memory bound) and keeps the valid cache. Remaining,
  specified as intended: the text of artifacts that discovery later rejects is counted too.
- **Item 2 — specified, with a regression test.** git canonicalises modes when it decodes a tree
  (`canon_mode`): measured with git 2.53, raw trees written with `hash-object --literally` list
  `100664`/`100600`/`100000` as `100644`, `120755` as `120000`, and `644`/`140000`/`160644`/`777777`
  as a `160000` submodule (skipped). `ls-tree -r` of a real repository therefore never prints
  another mode; the fail-closed branch only fires on output git does not produce (fake git). A new
  test scans a raw tree with `100664`, `100000` and `140000` entries.
- **Item 3 — specified.** One short slot, bounded by `HOSTED_GIT_TIMEOUTS.version + lsRemote`
  = 35 s, usually under a second; a second slot or a hosted lane needs dispatch by payload for a
  rare, bounded wait. Recorded in SPEC-105 §20 and referenced from SPEC-104 §20.
- **Item 4 — fixed, ⚠️ Decision needed (product choice).** Only `GIT_SSL_CAINFO` from the runner's
  environment is forwarded, as its `realpath`, and only when that is a readable regular file;
  anything else (relative, empty, directory, FIFO, missing, dangling, unreadable) fails every
  hosted step closed with a message naming the variable, not the path. git messages show the path
  as `<CA bundle>`. Never forwarded: `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAPATH`, `GIT_SSL_CERT`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`; no CA setting is read
  from any git config (existing isolation). The decision recorded in SPEC-105 §20: git's own
  variable (proposed) vs a DirectiveBench setting (`config.json` path per SPEC-007 §7, or a
  `DIRECTIVEBENCH_*` variable) vs no support. Reversible: one function (`resolveCaBundle`).
- Fail-closed error code for a bad CA setting: the existing `git-failed` (no new result code).

## Work performed

- `packages/core/src/discovery.ts`: `BinaryTreeFile`; `discoverArtifactsInTree` accepts it.
- `packages/runner/src/hosted-repository.ts`: `HOSTED_READ_BATCH_BYTES`, `readCandidateBlobs`,
  `readBatchBytes` option; `prepare` resolves the CA bundle first.
- `packages/runner/src/hosted-git.ts`: `CA_BUNDLE_VARIABLE`, `resolveCaBundle`,
  `HostedGitContext.caBundle`, `buildHostedGitEnv(…, caBundle)`, `<CA bundle>` in messages; the
  `listSnapshot` comment states why unknown modes cannot come from git.
- `apps/web/lib/actions.ts`: comment nit (`//srv/share` is UNC on Windows, an absolute path on
  POSIX).
- Tests: `packages/core/test/discovery-tree.test.ts` (parity with the walk when binaries are given
  as `BinaryTreeFile`; size before content), `packages/runner/test/hosted-repository-limits.test.ts`
  (binary under a tiny budget scans; text over it fails and keeps the cache; batching),
  `packages/runner/test/hosted-repository.test.ts` (raw tree with legacy modes),
  `packages/runner/test/hosted-git.test.ts` (CA resolution, refusals, env allowlist, hidden path),
  new `packages/runner/test/hosted-repository-tls.test.ts` (git over real TLS on loopback with a
  self-signed CA generated by `openssl`; skipped where `openssl` is missing or on Windows).
- Specs: SPEC-105 §9.1 (step 5, byte limits, env allowlist, TLS) and §20; SPEC-104 §9/§20
  (FR-104-05 characters, short lane); SPEC-201 §13 (TLS).

## Verification

- Red first: with `hosted-repository.ts` reverted to `main`, the three new or changed tests in
  `hosted-repository-limits.test.ts` fail; without the line that forwards the bundle to git, the
  loopback TLS test and the env test fail; with the change, all pass. The legacy-mode test passes
  on `main` too (it pins git's canonicalisation; item 2 needed no code change).
- `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` pass; `pnpm test` 7/7 tasks, 100%
  statements/branches/functions/lines everywhere (runner 219 tests, core 240, web 144, database
  120, benchmark-engine 110, cli 75, agent-adapters 34); `pnpm build` pass; `pnpm verify:pack`
  passed; `pnpm test:e2e` 37 passed.
- Real app (built `apps/cli/dist/cli.js serve`, a fresh temporary data dir per case, UI driven by
  a Playwright script, github.com reachable, git 2.53 with libcurl/GnuTLS):
  - default environment: registered `https://github.com/anthropics/skills`, scanned commit
    `dbd4588f9e10`: 445 files, 20 artifacts, 56 warnings, 0 errors, `sync_status = ok`;
  - `GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt`: registered;
  - `GIT_SSL_CAINFO=/etc/ssl/certs` (a directory): the form shows "GIT_SSL_CAINFO must be the
    absolute path of a readable CA bundle file (not a regular file). Fix or unset it to reach
    GitHub repositories."; nothing stored;
  - `GIT_SSL_NO_VERIFY=1` and `SSL_CERT_FILE=<unrelated CA>`: registered (neither forwarded);
  - `GIT_SSL_CAINFO=<unrelated self-signed CA>`: **registered** — `GIT_CURL_VERBOSE=1` shows this
    git also trusts its compiled-in `CApath /etc/ssl/certs`, so the variable adds to the system
    store here (spec wording corrected, lesson recorded). That an unknown CA fails is proven by the
    loopback TLS test instead.
- Not verified: Windows (Schannel needs `http.schannelUseSSLCAInfo`) and macOS git builds; a real
  TLS-intercepting proxy; a repository with more than 32 MiB of loadable candidates against
  github.com (batching is covered by the test with a small batch size).

## Problems and deviations

- `git mktree` and `git cat-file -p` normalise modes, so the first legacy-mode fixture was not
  armed; the raw tree is now written with `hash-object --literally` and checked with
  `cat-file tree` (lesson).
- The loopback server first answered 404; git reports that as `repository '…' not found`, which
  `classifyRemoteFailure` maps to `git-failed`, not `auth-required`. github.com answers 401 for a
  missing or private repository, so the server now does too; the 404 wording is a follow-up.
- The spec draft said a CA bundle "replaces" git's default; the real run disproved it (above).

## Review rounds

- Independent security review at `ef1db45` (`om-code-review`, own worktree; lint, typecheck,
  test passed): REQUEST CHANGES, 1 major, 3 minors, 2 nits. TLS handling found sound (no
  verification bypass, no CA from git config, fail-closed resolution, loopback-only tests).
  - Major, fixed: a text blob kept from step 5 was a `subarray` of the batch's whole stdout
    buffer, so dropping binary blobs freed nothing while any text of the batch was held (a
    repository of compressible 5 MiB binaries plus one small `.md` per batch could hold
    gigabytes). Text blobs are now copied into their own buffer; regression assertion: every
    buffer handed to discovery owns exactly its bytes (fails with the view, passes with the copy).
  - Minor, specified: step 5 has no total byte cap of its own (bounded by the candidate limits,
    the per-batch read timeout, local cache only) — SPEC-105 §9.1.
  - Minor, specified: a bad `GIT_SSL_CAINFO` also refuses a scan that would only read the cache
    (the check runs before any step; fail closed) — SPEC-105 §20.
  - Minor, fixed: the TLS test notes that `SSL_CERT_FILE`/`SSL_CERT_DIR` matter only on OpenSSL
    builds; the env unit test is the guard.
  - Nits, not changed: `<CA bundle>` replacement is a plain substring (only a local path, no
    secret); `100600` is not in the raw-tree test (the reviewer confirmed it lists as `100644`).

## Lessons recorded

- [2026-10-21-git-canonicalises-tree-modes.md](../lessons/2026-10-21-git-canonicalises-tree-modes.md)
- [2026-10-21-git-ssl-cainfo-is-not-exclusive.md](../lessons/2026-10-21-git-ssl-cainfo-is-not-exclusive.md)

## Follow-ups

- ⚠️ Decision needed: where the CA bundle comes from (`GIT_SSL_CAINFO` proposed; SPEC-105 §20).
- git's `repository '…' not found` (HTTP 404 over smart HTTP) is not classified as
  `auth-required`; harmless for github.com (401), relevant for other hosts later.
- `doctor` could report the CA bundle setting (SPEC-202 §8.3 plans it for GitLab).
