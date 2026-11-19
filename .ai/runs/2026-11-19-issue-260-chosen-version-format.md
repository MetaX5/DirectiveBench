---
title: Issue 260, the chosen version's format on the artifact page and what "same content" compares
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #260 (follow-up of #246 / PR #259), taken with the maintainer's approval
status: in-progress
branch: feat/issue-260-chosen-version-format
specs: [SPEC-126, SPEC-101, SPEC-103]
---

# Run: Issue 260, chosen version's format and `sameLatestContent`

## Objective

Decide, with the maintainer, which format the Artifacts list and the artifact page show for an
artifact whose chosen version (SPEC-126 FR-126-07) is not its latest one (deferred Q2 of #246), and
whether the Possible duplicates card's `sameLatestContent` compares the chosen versions (deferred
Q3). The maintainer accepts UI decisions only from screenshots or Storybook before any code, so
the run has two phases: A (options with visuals, then stop) and B (spec, implementation, tests).

## Plan

- Phase A: reproduce on `main` with the revert case, capture the current UI, prototype the options
  as throwaway code (not committed), write the decision document, push the branch with this log.
- Phase B (after the decision): spec updates, implementation, database test of the revert case,
  Storybook stories, Playwright in `apps/web/e2e/identity.spec.ts` (both themes, 320 px), full
  gate, browser QA, Codex adversarial review, draft PR, `om-auto-review-pr`.

## Decisions

None yet: waiting for the maintainer (decision document `.ai/tmp/issue-260-decisions.md`, not
committed; screenshots in `.ai/tmp/issue-260-shots/`).

## Work performed

Phase A (2026-11-19):

1. Worktree `.ai/tmp/issue-260-wt` on `feat/issue-260-chosen-version-format` from `origin/main`
   (6749c20). `pnpm build`, then `.ai/scripts/test-env-up.sh` (port 4398, demo data, mock agent).
2. Reproduction through the UI (register and scan local directories under `/var/tmp`): `repo-a`
   `.cursor/rules/style.mdc` cursor rule v1 → a directory holding skill `style` v2 → the cursor rule
   again (back to v1); `repo-b` another cursor rule `style`; `repo-c` a skill `style`. Database:

   | slug | type | `artifacts.format` | latest version | held by active occurrences |
   | --- | --- | --- | --- | --- |
   | style | rule | cursor-rule | skill-md v2 | v1 |
   | style-2 | rule | cursor-rule | cursor-rule v1 | v1 |
   | style-3 | skill | skill-md | skill-md v1 | v1 |

   The page header of `style` shows the badges "rule" "skill-md" "Possible duplicate"; the card
   lists the cursor rule `style-2`. The list shows no format at all (FR-101-10 has no Format
   column; `ArtifactListItem.format` is data only). The "Latest version (v2) · format skill-md"
   line is the Parsed metadata tab's card description, not the header.
3. Q3 example: three nameless skills `release-notes` (never matched): `repo-d` X v1 → Y v2 → back
   to X, `repo-e` Y, `repo-f` X. Today the card of `release-notes` says "Same latest content" for
   `repo-e` (differs on disk) and "Different content" for `repo-f` (identical on disk).
4. Throwaway prototype (saved as `.ai/tmp/issue-260-proto/prototype.patch`, reverted from the
   worktree): header options A, B, C and the chosen-version comparison, switched per request.
   Screenshots of every option in both themes at 1280 and 320 px.
5. Contrast of the new text measured on rendered pixels: the `muted` badges 5.51 (light) / 5.86
   (dark), "Same content" 19.80 / 17.18.
6. Found while reading: no `?format=` filter exists (`ArtifactListFilter` has none), so no option
   changes current filtering.

## Verification

Phase A only reproduces and prototypes; no product code changed and no gate was run.

## Problems and deviations

- The first reproduction attempt scanned too early: registering a repository does not scan it, so
  the script now scans after every registration.
- Issue 260 names a list "Format column" and a header line "Latest version (vN) · format X"; neither
  exists as described (see step 2). The decision document states what is actually visible.

## Lessons recorded

None yet.

## Follow-ups

- Phase B after the maintainer's decision on Q2 and Q3.
