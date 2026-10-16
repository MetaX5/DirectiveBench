---
title: Update SPEC-105 to fetch only candidate paths (issue #25)
date: 2026-10-17
agent: Claude Code / claude-opus-5-5
trigger: coordinator request for GitHub issue #25 (E01-S04-T01, story #18)
status: completed
branch: docs/25-spec-105-partial-fetch
specs: [SPEC-105, SPEC-104, SPEC-102, SPEC-007, SPEC-201]
---

# Run: Update SPEC-105 to fetch only candidate paths

## Objective

Issue #25: FR-105-05 describes a partial fetch of only candidate paths for public GitHub
repositories without credentials, OQ-105-04 is closed citing D06, NFR-105-02 (disk use) is updated.
Docs only, no code; spec status stays `draft`.

## Plan

1. Read AGENTS.md, SDLC.md, lessons, SPEC-105, SPEC-104, SPEC-102, SPEC-007, D06.
2. Compare git partial clone + sparse checkout, git partial clone + explicit blob fetch, and the
   GitHub REST API; check the git mechanics locally.
3. Update SPEC-105 (FR-105-05, new §9.1, NFR-105-02, §12, §13, §15, §16, §17, OQ-105-04), keep
   SPEC-104 FR-104-12 / NFR-104-03 consistent, add ADR-0012.

## Decisions

- Chosen: bare blob-less shallow clone, tree listing, pure candidate selection, one explicit
  blob-by-ID fetch, reads with lazy fetch disabled. Sparse checkout rejected (needs a working tree
  and cannot express skill directories before the tree is known); REST API rejected (60 req/h
  unauthenticated, truncation, GitHub-only). Recorded in ADR-0012 (Proposed).
- Hosted git calls ignore global/system git config and credential helpers so a public-only fetch
  can never use the user's credentials (otherwise a private repository would "work" silently,
  contradicting D06 and story #18's "not found or not public" criterion).

## Work performed

- SPEC-105: FR-105-05 rewritten, §9.1 "Hosted fetch: candidate paths only" added (steps, hardened
  invocation, error mapping), §1, §9 diagram, NFR-105-02, §12, §13, §15, §16, §17 updated,
  OQ-105-04 closed citing D06 and ADR-0012.
- SPEC-104: FR-104-12 and NFR-104-03 reference the hardened partial fetch and git ≥ 2.44.
- ADR-0012 added and indexed; lesson on blob-by-ID fetch and lazy fetch added.

## Verification

- Local git 2.48.1 experiment in the scratchpad (`file://` bare remote with
  `uploadpack.allowFilter=true`): clone with `--filter=blob:none --depth 1` held 0 blobs;
  `ls-tree -r -z` listed all paths without fetching; `ls-tree --long` with `GIT_NO_LAZY_FETCH=1`
  printed `BAD` sizes; `cat-file` of a missing blob failed with lazy fetch disabled; explicit
  `fetch --stdin --filter=blob:none` of two blob IDs failed without and succeeded with
  `fetch.negotiationAlgorithm=noop`, downloading exactly 2 objects and not the 200 KB
  non-candidate file; a lazy fetch was traced to spawn `git maintenance run --auto --detach`.
- `prettier --check .` (the `format:check` script, run through the main checkout's `node_modules`
  because `pnpm` is not on this machine's PATH): "All matched files use Prettier code style!"
  (`.ai` and `*.md` are in `.prettierignore`; markdown is not linted by ESLint). No code changed,
  so lint, typecheck and tests were not run.
- Not verified: behaviour against `github.com` itself (no network test was run), the minimum git
  version (2.44 is from release notes, an Assumption), self-managed GitLab partial clone support,
  Windows `/dev/null` equivalents.

## Problems and deviations

- The first explicit blob fetch failed with "bad revision"; fixed by noop negotiation (lesson).

## Lessons recorded

- [lessons/2026-10-17-git-partial-clone-blob-fetch.md](../lessons/2026-10-17-git-partial-clone-blob-fetch.md)

## Follow-ups

- Maintainer review of ADR-0012 and the §9.1 procedure before E01-S04 (#18) is implemented.
- Validate against a real public GitHub repository during E01-S04 (manual, not in CI).
- SPEC-104 §13 may need a dedicated `not-found-or-not-public` code instead of reusing
  `auth-required`.
