---
title: Edit tags, notes and benchmark suite assignments on the artifact detail page
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: user request (issue #64)
status: completed
branch: feat/artifact-metadata-editing
specs: [SPEC-101, SPEC-122]
---

# Run: Edit tags, notes and benchmark suite assignments on the artifact detail page

## Objective

Issue #64: on `/artifacts/[id]` the user can add and remove tags, edit the notes and assign or
unassign a benchmark suite. Input is Zod-validated in server actions; writes go through
`@directivebench/database`. A rescan keeps all of it (regression test); a Playwright test covers
the UI path. Only components, tokens and patterns the Storybook documents.

## Plan

Decisions D1 to D14 were listed before any code and accepted by the maintainer on 2026-10-28:

- D1: add a `Textarea` primitive (shadcn preset, Input tokens, stories and a docs page).
- D2: no new spec; SPEC-101 gets a "Detail editing (issue #64)" subsection. Notes are at most
  10 000 characters; a tag is free text without control characters or commas.
- D3: one suite per submit; an artifact may have several.
- D4: separate "Tags" and "Notes" cards in Overview; suites in the Benchmarks tab card.
- D5: `NativeSelect` of unassigned suites, no placeholder option, "Assign".
- D6: tag as `Badge secondary` plus `Button outline sm` "Remove" named for its tag.
- D7: one tag per submit, `maxLength` 64, disabled with a reason at 32 tags, a duplicate is a
  status, not an error.
- D8: notes always editable, empty clears them.
- D9: client forms with `useActionState`: pending state, kept value, focus on the invalid field.
- D10: unassign without confirmation.
- D11: wording as listed in the plan.
- D12: focus returns to the card's field after a remove or unassign.
- D13: token spacing; the Metadata card loses its off-token classes and dash placeholder.
- D14: "No tags yet." and the existing "No benchmark suite is assigned."

## Decisions

- The Textarea comes from `shadcn add textarea` (preset `radix-lyra`, dry run reviewed) and
  was migrated like Input: `border-control` instead of `border-input`, `text-ui` instead of
  `text-xs`, a solid `ring-ring` instead of `ring-ring/50`, `motion-reduce:transition-none`.
  The control-border guard in `test/design-tokens.test.ts` now covers it.
- Suite assignment from the UI uses new `assignArtifactSuite` and `unassignArtifactSuite`
  (one transaction each, outcomes instead of foreign-key errors, the suite name for the
  message). The CLI keeps `assignBenchmarkSuite`.
- Add and remove share one `useActionState` per card (`byIntent`), so the card has one status
  line and one pending state.
- The unassign message names the tab as the app labels it ("Results by version"), not
  "Evaluation history" as SPEC-101 calls it; found in the screenshot review.
- Not done: `e2e/versions.spec.ts` still seeds its tag with SQL (the #62 workaround). It
  could now use the UI, but that is outside this change.

## Work performed

1. Textarea primitive, stories (Playground, States, WithError, LongTextNarrowScreen), docs
   page with 13 sections, catalogue row, Start here, How to choose, Input, What is missing,
   `design-system.md`, SPEC-122 note.
2. Database: `addArtifactTag`, `removeArtifactTag`, `setArtifactNotes`, `assignArtifactSuite`,
   `unassignArtifactSuite`, limits `MAX_ARTIFACT_TAGS`, `MAX_ARTIFACT_TAG_LENGTH`,
   `MAX_ARTIFACT_NOTES_LENGTH`; tests including concurrency, kept runs and the rescan
   regression.
3. Web: Zod schemas and form state (`lib/artifact-metadata.ts`), five Server Actions
   (`lib/actions.ts`), client cards (`app/artifacts/[id]/metadata-forms.tsx`), page wiring;
   the Metadata card loses Tags, Notes, off-token spacing and its dash placeholder.
4. Playwright spec `e2e/artifact-metadata.spec.ts`; SPEC-101 §10, §11, §16 and status.

## Verification

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines, branches, functions and statements in every package (database 157 tests, web 278) |
| `pnpm test:storybook` | 62 files, 222 tests pass (Textarea stories in both themes with axe) |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:e2e` | 56 passed, including the 4 new tests |

Real app: the built CLI after `demo` on a scratch data directory, driven by a Playwright
script. While a save is delayed by 1.5 s the status reads "Saving the tags." and "Add tag" is
disabled. Screenshots of the Overview at 1440px light and dark and at 320px light, and the
Benchmarks tab after an unassign, were reviewed: no overflow, error under the field, value
kept.

Not verified:
- Red-first: the new e2e spec was not run against `main` (it cannot pass there: the cards do
  not exist). The rescan regression test passes on `main` code too, because rescans already
  kept user metadata; it guards the behaviour, it did not reproduce a bug.
- Text contrast of the new success, error and disabled-reason lines is not measured by
  `e2e/text-contrast.spec.ts` (it scans the Overview at rest only); they use tokens already
  measured elsewhere (`text-destructive-foreground`, `text-muted-foreground`).
- The 32-tag limit is covered by unit tests of the action and the repository; the disabled
  field and button with their written reason were not exercised in a browser.
- A screen reader was not used.

## Problems and deviations

- `pkill -f "port 4411"` also ended the shell running it (lesson of 2026-10-14 already says
  so); the server was stopped anyway.

## Lessons recorded

- [A React action form resets to the new render's `defaultValue`](../lessons/2026-10-28-action-forms-reset-to-the-new-default-value.md)

## Follow-ups

- A Combobox for suite assignment once there are many suites (on "What is missing").
- Move the "Focus after removing an item" rule into the Usage page or the Form pattern (see
  the PR's documentation gaps).
- `e2e/versions.spec.ts` can set its kept tag through the UI.
