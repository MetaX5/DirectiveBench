# ADR-0012: Fetch only candidate paths of hosted repositories with a git partial clone

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** Project maintainer (pending review; the product decision is
  [D06](../specs/research/decisions/D06-public-github-by-url-in-now.md))
- **Related:** [SPEC-105](../specs/2026-10-14-repository-synchronization.md) FR-105-05 and §9.1,
  [SPEC-104](../specs/2026-10-14-repository-management.md) FR-104-12,
  [SPEC-102](../specs/2026-10-14-artifact-discovery.md),
  [SPEC-007](../specs/2026-10-14-security-and-privacy.md),
  [SPEC-201](../specs/2026-10-14-integration-github.md), [ADR-0007](0007-local-runner-execution-and-isolation.md)

## Context

D06 puts registering a public GitHub repository by URL, without credentials, into Now and asks that
only the files DirectiveBench needs are fetched (SPEC-105 OQ-105-04). Artifacts are a tiny fraction
of a typical repository, and everything downloaded from it is untrusted. Constraints: no credentials,
TLS on, argv-only commands with an environment allowlist, never execute or check out repository
content, tests without network, and the same mechanism later for GitLab and credentialed fetches.

Candidate paths are not known before the tree is read: a `SKILL.md` can be anywhere and its whole
directory belongs to the skill (SPEC-102 FR-102-12).

## Decision

Use git with a two-phase partial fetch into a bare cache, never a working tree:

1. `git clone --bare --filter=blob:none --depth 1 --single-branch --no-tags` fetches the commit and
   its trees only. The commit read from the cache afterwards is the snapshot that is recorded, not
   the one `ls-remote` resolved earlier, because the branch can move in between.
2. `git ls-tree -r -z` lists the tree; a pure function selects candidate paths with the SPEC-102
   rules (formats, skill directories, excludes, include roots, count limits).
3. One `git fetch --filter=blob:none --stdin` with `fetch.negotiationAlgorithm=noop` downloads
   exactly the candidate blobs by object ID.
4. `git cat-file --batch` reads them with `GIT_NO_LAZY_FETCH=1`, so no read can download anything.

Every call uses the hardened invocation of SPEC-105 §9.1: HTTPS only, no credential helper or prompt,
global and system git config ignored, an environment allowlist, TLS verification on, no hooks,
fsmonitor, filters, LFS, submodules or background maintenance.

A local check (git 2.48, `file://` bare remote with `uploadpack.allowFilter=true`) confirmed that the
clone holds no blobs, that `ls-tree` without `--long` works without fetching, that an explicit
batched fetch of two blob IDs downloads exactly those two objects and not a 200 KB non-candidate
file, and that with lazy fetching disabled a missing blob fails instead of being fetched. Lazy
fetching otherwise spawns `git fetch` and `git maintenance run --auto`, hence the disabled lazy
fetch and `maintenance.auto=false`.

## Alternatives considered

- **Sparse checkout** (`clone --filter=blob:none --no-checkout` + `sparse-checkout set` +
  `checkout`) — creates a working tree, so `.gitattributes` filters, LFS, symlinks and
  case-insensitive path collisions become attack surface (SPEC-105 FR-105-18 forbids checkout).
  Cone patterns select directories only, and non-cone patterns cannot express "the directory of
  every `SKILL.md`" before the tree is known, so it still needs the tree listing first.
- **GitHub REST API** (`git/trees?recursive=1` + contents/blobs) — unauthenticated limit of 60
  requests per hour per IP (SPEC-201) is exhausted by one repository with a few dozen files; the
  recursive tree response is truncated for large repositories; GitHub-only (no GitLab, no
  `file://` tests); a second HTTP client and response parser to secure.
- **Full shallow bare clone** (previous FR-105-05) — simplest, but downloads every blob of the
  commit, including large binaries and build output, which D06 asks to avoid.
- **Server-side sparse filter** (`--filter=sparse:oid=…`) — not supported by GitHub.

## Benefits

- Transfer and disk use scale with the artifacts, not the repository.
- Non-artifact content of an untrusted repository never reaches the disk.
- Provider-neutral git transport; tests use a local bare repository without network.
- Later syncs reuse blobs by object ID, so unchanged files are never downloaded again.

## Drawbacks

- Two or three network round trips per sync instead of one.
- Requires git ≥ 2.44 for `GIT_NO_LAZY_FETCH` (Assumption — requires validation) and server support
  for partial clone; a server that ignores the filter yields a full shallow clone (correct, larger).
- Blob sizes are unknown before download, so byte limits are enforced after the fetch; the transfer
  is bounded only by the cache size limit and timeouts.
- Unreachable objects accumulate in the cache; it is re-created when it exceeds the size limit.

## Consequences

SPEC-105 FR-105-05, NFR-105-02, §9.1, §12, §13, §15 and §16 describe this procedure and OQ-105-04
is closed; SPEC-104 FR-104-12 and NFR-104-03 reference it. The planned `packages/git-providers`
implements steps 1–4 and the selection function; `directivebench doctor` must report a git version
too old for hosted repositories.

## Status

Proposed. Revisit if GitHub or GitLab stop serving blob-by-ID fetches on partial clones, if the git
minimum version is a problem for users, or when credentialed fetch is specified.

## Validation (2026-10-20, issue #18)

Implemented in `packages/runner/src/hosted-git.ts` and `hosted-repository.ts` (not in a separate
`packages/git-providers` yet). A manual run of the built CLI with git 2.53 against
`https://github.com/anthropics/skills` confirmed that github.com serves the blob-less shallow clone
and the batched blob-by-ID fetch with `fetch.negotiationAlgorithm=noop`: 324 candidate blobs of 445
files were downloaded, none of the non-candidates. The status stays Proposed until the maintainer
reviews it.
