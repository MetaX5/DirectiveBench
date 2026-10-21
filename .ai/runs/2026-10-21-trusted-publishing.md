---
title: Publish npm releases from GitHub Actions with trusted publishing
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request (after the manual 0.1.0 publish)
status: completed
branch: ci/trusted-publishing
specs: [SPEC-010]
---

# Run: Publish npm releases from GitHub Actions with trusted publishing

## Objective

Publish every later version of `directivebench` from CI, with npm provenance and no npm token in
the repository.

## Plan

Spec the release process (SPEC-010 §12), add `.github/workflows/release.yml`, document the steps
in `CONTRIBUTING.md`.

## Decisions

- Trigger: a published GitHub release; the tag must be `v<version>` of `apps/cli/package.json`.
- The job runs in the GitHub environment `npm`, so the npm trusted-publisher entry can be bound to
  it and protection rules (required reviewers) can be added later without changing the workflow.
- Pre-releases go to the dist-tag `next`, so `latest` only moves for full releases.
- `npm publish` from `apps/cli` (Node 24's npm 11 supports OIDC trusted publishing), after
  `pnpm build` and `pnpm verify:pack`.

## Work performed

- SPEC-010 §12 "Publishing releases" (Implementation status renumbered to §13).
- `.github/workflows/release.yml`, actions pinned to the same SHAs as `ci.yml`.
- `CONTRIBUTING.md`: "Releasing (maintainers)".

## Verification

- The workflow YAML parses; the tag check accepts `v0.1.0` and rejects `v0.2.0` and `0.1.0`.
- `npm publish --dry-run --provenance --access public --tag latest` in `apps/cli` packs 290 files
  and stops only at "You cannot publish over the previously published versions: 0.1.0".
- Not verified: an actual release run. It needs the trusted publisher configured on npmjs.com and
  a new version; the first real release is the test.

## Problems and deviations

None.

## Lessons recorded

None.

## Follow-ups

- On npmjs.com: package `directivebench` → Settings → Trusted Publisher → GitHub Actions:
  owner `MetaX5`, repository `DirectiveBench`, workflow `release.yml`, environment `npm`.
- Then, in the same settings, disallow token-based publishing.
