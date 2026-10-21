---
title: Prepare the first npm release and add a code of conduct
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request (publish before someone takes the name; no code of conduct)
status: completed
branch: chore/npm-publish-prep
specs: [SPEC-010]
---

# Run: Prepare the first npm release and add a code of conduct

## Objective

Make `directivebench` ready for a first manual `npm publish` of 0.1.0, and add a code of conduct.

## Plan

1. Check that the npm name is free and what the package contains.
2. Add the npm page metadata; add `CODE_OF_CONDUCT.md` and link it.
3. Build, `verify:pack`, inspect the tarball.

## Decisions

- The user chose a manual first publish and trusted publishing from GitHub Actions later.
- Code of conduct: Contributor Covenant 2.1. The user chose no e-mail address; GitHub has no
  direct messages, so reports go through the repository's private reporting form (title
  "Code of conduct: …") or GitHub's report-abuse form.

## Work performed

- `npm view directivebench`: 404, the name is free (2026-10-21).
- `apps/cli/package.json`: `author`, `repository` (with `directory`), `homepage`, `bugs`.
- Found a vitest cache from `examples/node_modules` in the tarball; `assemble-dist.mjs` now skips
  `node_modules` when copying the examples and `verify-pack.mjs` checks for it.
- `CODE_OF_CONDUCT.md`, linked from `CONTRIBUTING.md` and `README.md`.
- `.github/CODEOWNERS`: `@cieslinho` added next to `@MetaX5` (user request; has write access).

## Verification

- `pnpm build && pnpm verify:pack`: passed, 290 files, "contains no node_modules" ok; before the
  fix the same working tree packed 292 files including the vitest cache.
- Not verified: the publish itself (needs the user's `npm login`).
- After merge, the user published `directivebench@0.1.0` (2026-10-21) and created the npm
  organisation `directivebench`. `npx -y directivebench@0.1.0` from the registry, with an empty
  npm cache: `--version` 0.1.0, `--help`, `demo` and `serve` (HTTP 200) work; 290 files.

## Problems and deviations

None.

## Lessons recorded

- [A local pack can contain files a CI pack never sees](../lessons/2026-10-21-publish-from-a-clean-tree.md)

## Follow-ups

- Publish 0.1.0, then update SPEC-010's implementation status (`npx directivebench` from the
  registry) once verified.
- Trusted publishing (OIDC) with provenance from a release workflow.
- Create the free `@directivebench` npm organisation so the internal package scope is reserved.
