---
title: Versions tab latest badge, hash copy button and first-seen provenance (issue #65)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5
trigger: issue #65 (follow-up of PR #62), run through om-auto-fix-issue (feature route)
status: in-progress
branch: feat/issue-65-versions-tab-provenance
specs: [SPEC-103, SPEC-101, SPEC-014, SPEC-122]
---

# Run: Versions tab latest badge, hash copy button and first-seen provenance (issue #65)

Source doc: .ai/specs/2026-10-14-artifact-versioning.md

## Objective

Complete the Versions tab of the artifact page as SPEC-103 §11 asks: a "latest" badge on the
newest version, a button that copies the full content hash, and "first seen at
<repo>:<path>@<short sha>" provenance (FR-103-02, FR-103-15). Acceptance criterion of issue
#65: each item is shown and covered by a Playwright test.

## Plan

Goal: on `/artifacts/<id>?tab=versions` a user sees which version is the latest, copies a
version's full hash with one click or key press, and sees where each version was first seen.

Scope: `packages/database/src/repositories/artifacts.ts` (`getArtifactDetail` also returns the
repositories its versions were first seen in), `apps/web/lib/artifact-versions.ts` (new: labels
and the copy helper), `apps/web/app/artifacts/[id]/page.tsx` (`VersionsTab` only),
`apps/web/app/artifacts/[id]/copy-hash-button.tsx` (new client component), unit tests,
`apps/web/e2e/versions.spec.ts`, the contrast specs, `what-is-missing.mdx`, SPEC-103 §20.

Non-goals: the "evaluated on vN, latest is vM" notice (FR-103-13), the "Removed upstream"
banner, per-version evaluation counts in the Versions table, a reusable design-system copy
component, the dash placeholders outside the Versions tab (issue 123). PR #198 edits the
Overview tab and `getArtifactDetail`'s category query; this run stays out of both.

Risks: clipboard access needs a secure context (127.0.0.1 is one; a LAN address over http is
not), so the failure path must say so and show the hash; PR #198 touches the same files.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data and library

- [ ] 1.1 `getArtifactDetail` returns the first-seen repositories; tests
- [ ] 1.2 `lib/artifact-versions.ts`: first-seen label, short commit, copy helper; tests

### Phase 2: Versions tab

- [ ] 2.1 Latest badge, copy button and First seen column
- [ ] 2.2 Design-system backlog row for issue 65

### Phase 3: Browser tests and docs

- [ ] 3.1 Playwright: latest badge, copy, first seen, keyboard, 320px, contrast in both themes
- [ ] 3.2 SPEC-103 §20 status, run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
