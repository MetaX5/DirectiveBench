---
title: Categories page and category page (SPEC-124 Phase 2, issue #22)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer approved implementing SPEC-124 Phase 2 only (issue #22)
status: completed
branch: feat/category-pages
specs: [SPEC-124, SPEC-101, SPEC-106, SPEC-014]
---

# Run: Categories page and category page (SPEC-124 Phase 2)

Source doc: .ai/specs/2026-11-04-category-lifecycle-and-assignment.md

## Objective

Implement SPEC-124 §21 Phase 2 only, following the approved UI decisions in §11, §11.1 and §11.2
(D1 to D15): web schemas and messages, the create, update and archive Server Actions, the
`/categories` page (New category, Active, Archived), the new `/categories/[slug]` page with the
Archive confirmation panel, archived chips on `/artifacts` and the artifact page, the archived
option selected in the category filter, `MAX_SLUG_PARAM_LENGTH` from core, the two UD-5 doc
lines, and Playwright coverage. Phases 3 (assignment on the artifact page) and 4 (bulk) are out
of scope; issue #22 stays open (`Refs #22`).

## Plan

Goal: a user creates, renames, archives (after a confirmation with the count) and unarchives
categories in the app, and archived categories never show as active anywhere.

Scope: `apps/web/lib/categories.ts` (new), `apps/web/lib/actions.ts`, `apps/web/lib/artifacts.ts`,
`apps/web/app/categories/**`, `apps/web/app/artifacts/page.tsx`,
`apps/web/app/artifacts/[id]/page.tsx` (chips only), `apps/web/stories/patterns/risky-action.mdx`,
`apps/web/design-system.md`, `apps/web/test/**`, `apps/web/e2e/**`, SPEC-124 §20, SPEC-101
FR-101-10 status.

Non-goals: assign and remove on the artifact page (Phase 3); bulk assign and remove,
`listArtifactIds`, `setCategoryForListedArtifacts` (Phase 4); the other dash placeholders on
`/artifacts` (issue 123); new components, variants or tokens.

Risks: e2e tests share one database, so the new tests must leave predefined categories as they
found them (or use their own categories) and the existing `/categories` e2e test must follow the
new layout; a 64-character name in the confirm button at 320px (D11 implementer note).

## Progress

PR: #196

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Library and actions

- [x] 1.1 `lib/categories.ts` schemas, messages and form state; tests — 7b015e0
- [x] 1.2 `createCategoryAction`, `updateCategoryAction`, `setCategoryArchivedAction`; tests — 7b015e0
- [x] 1.3 `MAX_SLUG_PARAM_LENGTH` from core; filter option helper; tests — 7b015e0

### Phase 2: Pages

- [x] 2.1 `/categories`: New category card, Active table, Archived card — 29e85c7
- [x] 2.2 `/categories/[slug]` with the Archive confirmation panel — 29e85c7
- [x] 2.3 Archived chips on `/artifacts` and the artifact page; archived option in the filter — 29e85c7
- [x] 2.4 UD-5 doc lines in `risky-action.mdx` and `design-system.md` — 29e85c7

### Phase 3: Browser tests and docs

- [x] 3.1 Playwright: categories flows, keyboard, 320px, contrast — 7b709cd
- [x] 3.2 SPEC-124 §20, SPEC-101 FR-101-10 status, run log — 7789847

## Decisions

- `updateCategory`'s `updated` outcome gained `previousName` (additive, SPEC-124 §8.2 updated),
  because D15 needs "Renamed to …" for a rename and "Saved." for a description-only change and
  the action had no other trustworthy way to tell them apart.
- The client forms get the limits and the counted copy (`archiveReason`, the status sentence) as
  props from the server pages: a client module that imports `@directivebench/core` makes
  Turbopack fail ("does not support external modules (request: node:fs)"), as the artifact
  page's `metadata-forms.tsx` already avoids.
- The Archive panel's open state is "open for the result it was opened after"
  (`openedAt === state`), so a new result closes it without a `setState` in an effect
  (`react-hooks/set-state-in-effect`).
- The confirming button keeps the text "Archive <name>"; at narrow widths its label truncates
  inside the panel (`max-w-full`, `truncate`), while the question above shows the full name and
  the accessible name stays complete (§11.2 implementer note: `flex-wrap` on the action form and
  `min-w-0` on the panel are there too).
- `PageHeader`'s `h1` and the slug `code` elements wrap anywhere: a 64-character name or slug
  without spaces scrolled the page sideways at 320px (688 px, then 238 px). This is a styling fix
  of an existing component, not a new variant.
- On `/artifacts` the category badges keep breaking only between words (SPEC-101 list-width rule,
  issue 122); the working document's `break-all` for chips is applied on the artifact page only.
- The description's control-character message "A description cannot contain line breaks or other
  control characters." mirrors the name's §13 wording; §13 lists no description-specific string.

## Work performed

1. `7b015e0` `lib/categories.ts` (schemas, `CategoryFormState`, outcome-to-message mapping,
   chip and filter helpers), the three Server Actions, `formatCount`, `MAX_SLUG_PARAM_LENGTH`
   from core, `previousName` on `updateCategory`; unit tests.
2. `29e85c7` `/categories`, `/categories/[slug]` with the Archive panel, archived chips and the
   archived filter option, UD-5 doc lines.
3. `7b709cd` Playwright (`categories.spec.ts`, `management.spec.ts`, `text-contrast.spec.ts`);
   `PageHeader` title and slug `code` wrap anywhere (320px with a 64-character name).
4. `7789847` SPEC-124 §8.2 and §20, SPEC-101 FR-101-10 and §20, lesson; list chips keep
   breaking only between words.
5. `acd09a0` review round 1: e2e for the empty Active state (D6).
6. `63f2ab5` QA D1: a rename that resolves an unarchive clash clears the stale refusal (Status
   card keyed by the name; regression test red without the key).
7. `826b035` Codex finding: "already archived" / "already active" revalidate the pages so a
   stale tab shows the real state (red-first unit test).

## Verification

Final head 826b035 (all on this machine, `TMPDIR` under `/var/tmp` for e2e and Storybook):

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test --force` | pass, 100% coverage: web 503, core 293, database 215, runner 244, cli 164, benchmark-engine 518, agent-adapters 364 (+2 skipped) |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:e2e` | 118 passed |
| `pnpm test:storybook` | 304 passed (68 files) |

Red-first: the D1 regression test failed without the `key` (alert count 1, expected 0); the
revalidation unit test failed against the previous `actions.ts`.

Real app: `sh .ai/scripts/test-env-up.sh` (demo data, mock agent only), then a scripted
Chromium run: create "Client A" ("Created Client A."), duplicate "client a" (field error), a tab
in the name (control-character error), "日本語" (slug `category-1`), rename DevOps to "CI and
Ops" (slug kept), Archive Security with Cancel (focus back on Archive) and confirmed ("Archived
Security. It stays on 1 artifact.", header badge), "Security (archived)" muted chip on
`/artifacts`, gone from the filter, `?category=security` selects "Security (archived)",
Unarchive; no console errors. Environment stopped with `test-env-down.sh`.

Reviews:

- `om-auto-review-pr 196 --autofix` round 1 (COMMENT): no blockers or majors; minor (empty
  state untested) fixed in acd09a0; nit kept (the "Create one above." branch only occurs without
  seeding); direction question on copy naming Phase 3 and 4 surfaces. Round 2 at 826b035: no
  blockers or majors.
- `om-auto-qa-pr 196` (agent-browser, both themes, 320px, keyboard, console): PASS with one low
  defect (D1), fixed in 63f2ab5. Evidence: PR comment with 26 screenshots.
- Codex adversarial review: round 1 (at 63f2ab5, started by mistake without `--wait`, read only
  partly) reported that "already archived" / "already active" skipped revalidation; confirmed and
  fixed in 826b035. Round 2 (`--wait --base origin/main`, given the local gate results) at
  826b035: **approve**, no material findings.

Not verified: the pending states ("Saving…", "Archiving…") are too short to observe; a newline in
a name through the browser (text inputs strip it; unit tests cover the raw check); the "Create
one above." empty-state branch (no categories at all); a category changed in another tab during
the Status card's pending request beyond the "already" outcomes.

## Problems and deviations

- Turbopack build panic from a client module importing core (see Decisions and the lesson).
- No deviation from §11.2 D1 to D15. Implementation details the spec leaves open are listed under
  Decisions (truncating confirm label, `PageHeader` wrap, description control-character message,
  `previousName`, list chips without `break-all`).

## Lessons recorded

- [A web client component must not import @directivebench/core](../lessons/2026-11-05-client-components-must-not-import-core.md)

## Follow-ups

- Phase 3 (assignment on the artifact page) and Phase 4 (bulk) of SPEC-124; issue #22 stays open.
- Copy that names Phase 3 and 4 surfaces ("Assign it on an artifact's page or to a filtered list
  on Artifacts.", "the bulk form") is accurate only once those phases ship (decision for the
  maintainer).
- QA cosmetic notes: a 64-character slug widens the Slug column in the Archived table at 1280px;
  `/artifacts?category=<unknown slug>` shows "All" selected with an empty list (existing behaviour).
