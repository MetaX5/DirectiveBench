---
title: Open relative links to sibling files in the Content tab (issue 55)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue 55 (feature route)
status: completed
branch: feat/issue-55-content-tab-relative-links
specs: [SPEC-101, SPEC-007]
---

# Run: Open relative links to sibling files in the Content tab (issue 55)

## Objective

Issue 55: in the Content tab's rendered Markdown, a relative link that resolves (after
canonicalisation, never escaping the artifact's root) to a file of the same artifact version opens
that file in the Content tab. Every other relative link stays inert; `..` escapes and absolute
paths are never followed (FR-101-18). Unit and Playwright tests cover both cases.

## Plan

1. Spec first: SPEC-101 FR-101-18 and §12 describe the sibling-link rule.
2. `apps/web/lib/markdown.ts`: a pure `resolveSiblingLink(fromPath, destination, paths)` that
   canonicalises lexically against the linking file's directory and returns a manifest path or null.
3. `Markdown` takes an optional `resolveLink` callback; the Content tab passes one that maps a
   resolved path to `artifactHref(..., { tab: 'content', version, file })`. The parser and the
   `safeHref` rule stay unchanged (keeps the diff small next to issue 52's Content-tab work).
4. Unit tests (100% coverage), a Storybook story, a Playwright test in `registry.spec.ts`.
5. Quality gate, real-app run, browser QA, PR, `om-auto-review-pr`.

## Decisions

- The decision is lexical, on the stored manifest only (no filesystem access): the target must be
  an exact, case-sensitive manifest path of the same version, and the href is built by the app
  (`artifactHref`), never taken from the destination.
- A `..` above the artifact's root makes the link inert even when a later segment would come back
  in (`../SKILL.md` from `SKILL.md`): the issue says escapes are never followed, so no clamping.
- A `#fragment` is dropped (the Content tab has no heading anchors); a `?query` keeps the link
  inert, as do backslashes, control characters and malformed percent-encoding.
- The parser and `safeHref` are unchanged; `Markdown` gets an optional `resolveLink` callback, so
  every other user of `Markdown` keeps the old behaviour and the Content tab diff stays small
  (issue 52 works in the same file).
- The pre-existing 15px overflow of the raw view at 320px (below) is left alone to keep the
  Content-tab diff focused.

## Work performed

1. Spec: SPEC-101 FR-101-18 and §12 describe the rule.
2. `apps/web/lib/markdown.ts` `resolveSiblingLink`; `Markdown` `resolveLink`; `ContentTab` passes
   one. Commit `feat(web): open relative links to sibling files in the Content tab`.
3. Tests: `apps/web/test/markdown.test.ts` "resolveSiblingLink (issue 55)"; `registry.spec.ts`
   fixture gains an escape, an absolute path and a back link, plus a new test; story
   `SiblingLinks`.

## Verification

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: 7/7 tasks pass, 100% statements, branches, functions and lines in every package.
- `pnpm build && pnpm verify:pack`: pass ("Packaging verification passed").
- `DIRECTIVEBENCH_E2E_PORT=4455 pnpm test:e2e`: 207 passed.
- `pnpm test:storybook`: 68 files, 344 tests passed.
- Red first: with the two components reverted (built), `registry.spec.ts` fails in the content
  test (`[data-inert-link]` also holds "a relative link"); the serial suite then skips the new test.
- Real app: built CLI `serve` on 127.0.0.1:4456 with its own data dir after `demo`, fixture skill
  with 11 kinds of links. Exploratory browser QA agent (chrome-devtools): every link behaves as
  specified, back/forward, keyboard (focus ring, Enter), 19 crafted `file=` URLs fall back with a
  notice, both themes, contrast 17.36:1 dark / 19.55:1 light, no console messages. No defects.
- Not verified: the Codex adversarial review (the `codex` CLI is not installed on this machine);
  screen-reader output; Firefox and WebKit; Windows.

## Problems and deviations

- `pnpm` was not on `PATH`: `corepack pnpm` worked, but every turbo script failed with "Unable to
  find package manager binary" (lesson below).
- The Playwright headless shell build was missing; reinstalled from the worktree (existing lesson
  of 2026-11-16).
- QA observation, pre-existing and not caused by this change: at 320px with a classic scrollbar
  the raw view's longest unbreakable token gives a 15px horizontal scroll (the content column's
  grid item keeps `min-width: auto`).

## Lessons recorded

- [turbo needs a `pnpm` binary on PATH](../lessons/2026-11-19-turbo-needs-pnpm-on-path-not-only-corepack.md)

## Follow-ups

- Raw view overflow at 320px (above): `min-w-0` on the Content tab's content column.
- Inert links show their target only in a `title` tooltip, unreachable by keyboard and touch;
  focus returns to the body after following a sibling link (both pre-existing patterns).
