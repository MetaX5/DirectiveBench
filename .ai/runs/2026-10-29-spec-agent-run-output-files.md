---
title: Spec for keeping and reviewing agent output files (E08, issue #152)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5 (om-auto-write-spec, om-spec-writing --autonomous)
trigger: maintainer request, issue #152
status: completed
branch: spec/agent-run-output-files
specs: [SPEC-123, SPEC-118, SPEC-112, SPEC-014]
---

# Run: Spec for keeping and reviewing agent output files (E08)

## Objective

Write a draft spec for issue #152 (E08): keep the files an agent run wrote and let a human read,
compare, export and blind-review them. The maintainer's decisions of 2026-10-29 on the issue
(limits 1 MB per file and 10 MB per agent run, retention with the benchmark run, blind review in
scope, access through the run page, CLI export and a side-by-side diff) were binding inputs. No
code was to be written.

## Plan

Read the D03 run log, D09, SPEC-118, SPEC-112, SPEC-014 and the design-system summary; check
the engine (`runAgent`), the schema and the adapter contract; draft SPEC-123; have a fresh agent
review it; render static mockups; open a spec PR.

## Decisions

Autonomous defaults A1 to A14 are listed in SPEC-123 §5a. A14 (new UI components) needs the
maintainer's approval under `apps/web/design-system.md`, so it is marked as needing human
confirmation and the PR stays a draft.

## Work performed

1. Read the context above; confirmed in code that workspaces are removed in `runAgent`'s
   `finally`, `changedFiles` holds paths only, no run deletion exists, foreign keys are on, and
   only the adapter knows the API key (so redaction needs an adapter method).
2. Drafted `.ai/specs/2026-10-29-agent-run-output-files.md` (SPEC-123) and added it to the index.
3. A fresh-context review agent returned 10 findings (redaction margin at the cut, capture racing
   a timed-out agent, phase dependencies, blindness bypass through labelled views, ids in blind
   URLs, change detection, concurrent review start, export collisions, pair integrity, untestable
   NFRs). All 10 were addressed in the spec.
4. Rendered four static mockups with agent-browser under `.ai/specs/assets/agent-run-output-files/`.

## Verification

- No code changed, so no quality gate was run.
- Mockup PNGs rendered and checked to be non-empty; one was inspected visually.
- Not verified: screenshots of the current app (no test-environment descriptor exists in
  `.ai/qa/`); any claim about Promptfoo or LangSmith (stated from general knowledge and marked so).

## Problems and deviations

None.

## Lessons recorded

None (no bug fixed, no correction received).

## Follow-ups

- Maintainer: confirm or override A1 to A14, especially A14.
- Implementation via `om-auto-implement-spec .ai/specs/2026-10-29-agent-run-output-files.md`,
  phase by phase.
