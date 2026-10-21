---
title: Harden the repository after making it public
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request (repository switched from private to public)
status: completed
branch: chore/repo-hardening
specs: [SPEC-012]
---

# Run: Harden the repository after making it public

## Objective

Turn on the free GitHub security features that make sense now that the repository is public,
and add the supporting repository files.

## Plan

1. Inspect the repository settings with `gh api`.
2. Apply settings through the API (no repository files involved).
3. Add Dependabot configuration, CODEOWNERS and SHA-pinned actions in one PR.

## Decisions

- Actions are pinned to the commit of their current `v4` tag (the major already in use), with the
  exact version as a comment; Dependabot proposes newer majors and keeps the pins current.
- Dependabot groups minor and patch updates per dependency type to limit PR noise; majors arrive
  as separate PRs.
- Paid secret-scanning extras (non-provider patterns, validity checks) stay off.

## Work performed

Repository settings changed through the API (before the PR):

- Private vulnerability reporting enabled (the reporting channel `SECURITY.md` points to).
- Secret scanning and push protection enabled.
- Dependabot alerts and Dependabot security updates enabled.
- Fork pull-request workflows require approval for all external contributors.
- Head branches are deleted automatically after merge.
- CodeQL default setup configured (JavaScript/TypeScript and GitHub Actions).
- Repository topics added.

Repository files (this PR):

- `.github/dependabot.yml`: weekly npm and GitHub Actions updates.
- `.github/CODEOWNERS`: `* @MetaX5`, so the branch protection's code-owner review rule applies.
- `.github/workflows/ci.yml`, `.github/actions/setup/action.yml`: third-party actions pinned to
  commit SHAs.

## Verification

- Every setting was read back through `gh api` after the change and showed the new value.
- Pinned SHAs were resolved with `gh api repos/<action>/commits/v4` and matched to their tags.
- `prettier --check .github` passes. CI on the PR verifies the pinned actions resolve and run.
- Not verified: the Dependabot configuration is validated by GitHub only after merge to `main`.

## Problems and deviations

None.

## Lessons recorded

None; no non-obvious problem was hit.

## Follow-ups

- Optional: OpenSSF Scorecard workflow; `npm publish --provenance` once the package is published.
