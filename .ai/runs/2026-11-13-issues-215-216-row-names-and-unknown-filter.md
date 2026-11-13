---
title: Unique row button names on /repositories and unknown filter values on /artifacts (issues 215, 216)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: user request (maintainer-approved UI decisions E1 to E8 for issues #215 and #216)
status: in-progress
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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Library helpers (red first)

- [ ] 1.1 Unit tests for repositorySubject, repositoryOptions, dropUnknownFilters and filterNotice (failing)
- [ ] 1.2 Implement the helpers in lib/repositories.ts and lib/artifacts.ts

### Phase 2: Pages and browser tests

- [ ] 2.1 Repositories row buttons use repositorySubject, with the issue 215 e2e test
- [ ] 2.2 Artifacts page drops unknown repository and category filters, with the issue 216 e2e tests and contrast URL

### Phase 3: Specs and Storybook docs

- [ ] 3.1 SPEC-125 and SPEC-101 text (E7)
- [ ] 3.2 Storybook pages and the risky-action story (E7)

### Phase 4: Verification

- [ ] 4.1 Full quality gate
- [ ] 4.2 Real-app run and exploratory browser QA
- [ ] 4.3 Codex adversarial review until approve
- [ ] 4.4 Open the PR and run om-auto-review-pr
- [ ] 4.5 Finalise the run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
