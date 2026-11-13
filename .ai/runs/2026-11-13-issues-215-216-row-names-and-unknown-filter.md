---
title: Unique row button names on /repositories and unknown filter values on /artifacts (issues 215, 216)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: user request (maintainer-approved UI decisions E1 to E8 for issues #215 and #216)
status: completed
branch: fix/issues-215-216-row-names-unknown-filter
specs: [SPEC-101, SPEC-125]
---

# Run: Unique row button names and unknown filter values (issues 215, 216)

## Objective

Close issues #215 and #216 exactly as the maintainer-approved decisions E1 to E8 say (prepared on
2026-11-12, approved in comments on both issues):

- E1: the Scan and Remove buttons of every `/repositories` row are named with the verb plus the
  `describeRegistration` subject, "Scan skills (Local Git, /home/dev/skills)", built by one new
  helper `repositorySubject` in `lib/repositories.ts`.
- E2, E3: a well-formed `repository` id on `/artifacts` that names no registered repository is
  dropped (the full list shows), named in the existing `filter-notice` line ("Ignored the
  repository in the URL: it is not registered."), counts as invalid for "Clear filters" and puts
  the bulk category row in its `invalid-url` state.
- E4: the repository select's suffix for a shared name is the E1 subject (provider and location).
- E5: the same rule for a well-formed `category` slug that names no category ("Ignored the
  category in the URL: it does not exist.").
- E6: no layout or tab-order change.
- E7: SPEC-125 (FR-125-15, §11 Phase 2 list, §11.3 D12 and D14, §20 follow-up line), SPEC-101
  (§11 List filters, §13, §20) and the Storybook pages `primitives/table.mdx`,
  `design-system/content.mdx`, `patterns/filtered-list.mdx`, `patterns/risky-action.stories.tsx`.
- E8: unit tests (100% coverage of the touched `lib` code) and Playwright tests per the decisions'
  Tests section.

Acceptance: every listed test passes red-first where it pins the bug, the full gate is green, the
real app shows the behaviour, browser QA and the Codex adversarial review approve.

## Plan

Engine: om-auto-create-pr (steps: 11, --loop: no). Non-goals: issues #219 and #220, the other
ambiguous names listed in the decisions doc ("Unassign suite", "Remove category"), SPEC-126.

## Progress

PR: #222

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Library helpers (red first)

- [x] 1.1 Unit tests for repositorySubject, repositoryOptions, dropUnknownFilters and filterNotice (failing) — 6f23c17
- [x] 1.2 Implement the helpers in lib/repositories.ts and lib/artifacts.ts — 6f23c17

### Phase 2: Pages and browser tests

- [x] 2.1 Repositories row buttons use repositorySubject, with the issue 215 e2e test — 50425a5
- [x] 2.2 Artifacts page drops unknown repository and category filters, with the issue 216 e2e tests and contrast URL — 4f33cbe

### Phase 3: Specs and Storybook docs

- [x] 3.1 SPEC-125 and SPEC-101 text (E7) — 94efc65
- [x] 3.2 Storybook pages and the risky-action story (E7) — 19172e8

### Phase 4: Verification

- [x] 4.1 Full quality gate — 19172e8
- [x] 4.2 Real-app run and exploratory browser QA — 19172e8
- [x] 4.3 Codex adversarial review until approve — 19172e8
- [x] 4.4 Open the PR and run om-auto-review-pr
- [x] 4.5 Finalise the run log

## Decisions

No decision was taken without the maintainer: E1 to E8 were approved on issues #215 and #216
before any code. Implementation choices inside them:

- `filterNotice(invalid, unknown)` is a new helper next to `invalidParamsNotice`, which the
  artifact detail page keeps using unchanged.
- The page passes `[...invalid, ...unknown]` as `invalid` to `bulkCategoryModel`, so the bulk
  row's `invalid-url` state needs no new parameter.
- The table story's `RowAction` (distinct names) is unchanged: E7 names only the docs pages and
  the Risky-action story.

## Work performed

1. `6f23c17` `repositorySubject`, `repositoryOptions` with the provider, `dropUnknownFilters`,
   `filterNotice`, with unit tests written first.
2. `50425a5` `/repositories` row buttons named `Scan|Remove ${repositorySubject(repository)}`;
   e2e "row button names (issue 215)" (two folders called `skills`, then `git init` in one and a
   second registration) plus the E4 option check.
3. `4f33cbe` `/artifacts` lists repositories and categories first, drops unknown ones, and uses
   the ignored list for the notice, "Clear filters" and the bulk row; e2e in `registry.spec.ts`
   (`repo_never`, `no-such-category`, combined with `type=script`, a known filter next to an
   unknown one) and `missing-occurrences.spec.ts` (the removed repository's id), and
   `/artifacts?repository=repo_never` in `text-contrast.spec.ts`.
4. `94efc65` SPEC-125 FR-125-15, §11 Phase 2 list, §11.3 D12 and D14, §20; SPEC-101 §11, §13, §20.
5. `19172e8` Storybook: `primitives/table.mdx` §7 and Do/Don't, `design-system/content.mdx`
   Buttons, `patterns/filtered-list.mdx` rule 5, `risky-action.stories.tsx` button name.
6. Lesson on e2e registration fixtures (see below).

## Verification

Full gate on `19172e8`, with `TMPDIR=/var/tmp`:

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | 7/7 packages; 100% statements, branches, functions and lines in each (web: 1531/1531 statements) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 155 passed |
| `pnpm test:storybook` | 68 files, 310 tests passed (both themes, axe) |

Red first:

- Unit: before the helpers existed, 12 new tests failed (`dropUnknownFilters is not a
  function`, `filterNotice is not a function`, `repositorySubject is not a function`, and both
  `repositoryOptions` tests, whose old labels were `skills (/a/skills)` twice for one directory
  under two providers).
- E2e, with the page changes stashed and the app rebuilt: the issue 216 tests in
  `registry.spec.ts` and `missing-occurrences.spec.ts` failed on `filter-notice` not found (the
  page showed "No artifacts match the filters"); the issue 215 test failed on
  `getByRole('button', { name: 'Scan skills (Local directory, …/a/skills)', exact: true })` not
  found. All pass with the fix (32 in the four touched files, then 155 in the full run).

Real app: `TEST_ENV_PORT=4397 sh .ai/scripts/test-env-up.sh` (built CLI, demo data, mock agent
only), then an exploratory browser QA agent (agent-browser): three rows named `skills` (two
folders, one also as Local Git), six unique row button names with visible "Scan"/"Remove",
keyboard Tab and Enter to the removal panel, removal, `/artifacts` with the removed id,
`repo_doesnotexist`, `no-such-category`, malformed and repeated values, combinations with
`type=script` and `q`, a known filter next to an unknown one, an archived category (archived and
unarchived again), both themes, 320px (no page scroll, the three-sentence notice wraps),
console clean, notice contrast 6.01:1 light and 6.94:1 dark. **No defects found.** Screenshots
on branch `qa-evidence-pr-222` (`pr-222/`). `test-env-down.sh` stopped the server and removed
its data.

Not verified: screen-reader and voice-control output of the longer names; the bulk row with an
unknown filter next to a valid archived category on a non-empty list (the demo data has none).

## Review

| Round | Head | Verdict | Findings and outcome |
| --- | --- | --- | --- |
| Browser QA agent (agent-browser) | 19172e8, built app | pass | No defects |
| Codex adversarial 1 (`--scope branch --base main`, target "branch diff against main") | 19172e8 | approve | No material findings |
| `om-auto-review-pr 222 --autofix` (engine `om-code-review`) | 8479976 | approve (posted as a COMMENT: self-review) | Two nits left as is: the `repositorySubject` comment says the removal question "uses" the format (it builds the same text inline for `font-mono`); an orphan JSDoc above `missingNote` from `main` |

## Problems and deviations

- The first issue 215 e2e run timed out on "Waiting for the runner": its folders sat under the
  spec's `sources`, which an earlier test registers, so the page asked for a confirmation. The
  fixture now has its own root (lesson below). The test also has `4 × REGISTRATION_TIMEOUT` for
  its three registrations.
- The QA agent's three fixture artifacts stayed in its throwaway demo database as missing
  (removal keeps history); that database was deleted by `test-env-down.sh`.

## Lessons recorded

- [An e2e registration fixture needs its own root](../lessons/2026-11-13-e2e-registration-fixtures-need-their-own-root.md)

## Follow-ups

- The same-name ambiguity elsewhere listed in the decisions doc is out of scope here and tracked:
  "Unassign suite <name>" by issue #219, archived categories' "Remove category" names and the
  `/categories` links by issue #220.
