---
title: Design-system documentation in Storybook (SPEC-122, #134)
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: maintainer request ("zaczynaj 134"), issue #134, prompt .ai/specs/briefs/2026-10-27-design-system-storybook.md
status: in-progress
branch: feat/design-system-storybook
specs: [SPEC-122, SPEC-119, SPEC-120, SPEC-121]
---

# Run: design-system documentation in Storybook

## State

- **Completed stages:** 0 (inventory and plan).
- **Approved by the maintainer:** nothing yet for this work. #132 was merged first, as the
  prompt requires.
- **Open questions:** SPEC-122 §18 Q1–Q5 and proposals P1–P5.
- **Next step:** wait for "dalej" and the answers, then start stage 1 (foundations).

## Objective

Build the design-system documentation in Storybook following the prompt in stages 0 to 5,
stopping after each stage for the maintainer's "dalej". The acceptance criteria are in
SPEC-122 §16.

## Plan

See SPEC-122, Implementation Plan.

## Decisions

None yet; stage 0 only proposes.

## Work performed

Stage 0:
- Read the prompt, AGENTS.md, the lessons, the product brief, SPEC-119, SPEC-120,
  SPEC-121 and `tokeny.md`.
- Inventoried the routes, the components, the product components locked in page files and the
  planned screens (`backlog.md`, SPEC-109, SPEC-113, SPEC-115, SPEC-116, SPEC-118, the
  category spec).
- Researched the Storybook version and add-ons for Next 16.4, React 19.3, Tailwind 4.3 and
  Vitest 5. Both research tasks ran as subagents.
- Wrote the draft SPEC-122 and this run log.

Inventory facts used by the plan:
- Every page is a server component that reads the database. No component outside `app/`
  reads data itself.
- `components/ui` has no `next/*` or `server-only` imports.
- `nav.tsx` uses `usePathname`, and `auto-refresh.tsx` uses `useRouter`.
- Two app-authored strings still contain an em dash (`components/common.tsx:73`, `:137`).

## Verification

Stage 0 produced documents only. Nothing was built or installed.

## Problems and deviations

None.

## Lessons recorded

None yet.

## Follow-ups

See SPEC-122 §18 and §19.
