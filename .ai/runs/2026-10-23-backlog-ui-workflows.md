---
title: Capture UI follow-ups and repository workflow planning
date: 2026-10-23
agent: OpenAI Codex
trigger: Maintainer requests backlog entries and issues
status: completed
branch: feat/shadcn-design-system
specs: [SPEC-101, SPEC-116, SPEC-118, SPEC-119]
---

# Run: Capture UI follow-ups and repository workflow planning

## Objective

Record the Full HD artifact-table usability issue, the application UI copy rule prohibiting
en/em dashes, and the planning gap for full repository workflow benchmarks. No feature
implementation was requested.

## Plan

- [x] Read backlog, product decisions and relevant specifications.
- [x] Search open issues and PRs using varied queries and inspect nearby candidates.
- [x] Reproduce the artifact-table overflow at 1920x1080 with mock demo data.
- [x] File actionable issues with labels, acceptance criteria and specification references.
- [x] Add issue mappings to the local backlog and record the new standing UI-copy rule.
- [x] Verify tracker writes and local documentation, finalize this log.

## Decisions

Use om-prepare-issue for tracker creation. Local backlog edits are explicitly requested by
the maintainer, overriding its default tracker-only scope for that part of this task.
The workflow direction is already D02/S3; file a dedicated design task under Later rather
than treating it as an unplanned S1 implementation. Preserve imported text and raw traces
when applying the app-authored UI copy policy.

## Work performed

No duplicates found for the table width or typography rule. Issue #53 concerns list
capabilities, #64 editing artifact metadata, and #74 mock badges on the suite list; none
addresses this layout. #14 already parks chains, while #93 explicitly excludes them from S1.
Independent read-only research confirmed D02 includes whole chains and requires their own spec.

The Full HD reproduction used an installed CLI tarball and fresh demo data: table container
clientWidth 1056px versus scrollWidth 1134px at a 1920px viewport. The layout caps main at
max-w-6xl; description is already truncated with max-w-xs, so the issue should address
the overall column budget and category/status wrapping, not assume descriptions are unlimited.

## Verification

- Created and read back [#122](https://github.com/MetaX5/DirectiveBench/issues/122),
  [#123](https://github.com/MetaX5/DirectiveBench/issues/123), and
  [#124](https://github.com/MetaX5/DirectiveBench/issues/124): all open, exact titles,
  guarded category/priority/risk labels and stable backlog IDs verified.
- #122 includes an inline reproduction PNG on the dedicated slash-free evidence branch
  `qa-evidence-artifacts-full-hd-2026-10-23`; inspected before upload. Original pasted
  screenshot remains identified separately. No source changes were published there.
- Backlog maps F01 to #122, F02 to #123 and E05-T01 to #124 under existing Later epic #14.
- AGENTS.md records the app-authored UI-copy ban; existing UI cleanup/CI enforcement is
  explicitly deferred to #123. No app or package source was changed in this run.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`: pass; typecheck 7/7 tasks,
  unit tests 1,666 at 100% coverage (6 test tasks cached, web executed).
- `git diff --check` and local backlog-ID/URL consistency checks: pass.
- No build or full E2E rerun: no app, packaging or dependency changes. The real-app
  reproduction uses the already-built installed CLI. No PR, merge or implementation
  of the deferred tasks was requested.

## Problems and deviations

The original pasted screenshot has no exposed local file path. A separate reproduction
screenshot with synthetic demo data was captured for durable tracker evidence, clearly
labelled as a reproduction rather than the original image.

## Lessons recorded

[No long dashes in UI copy](../lessons/2026-10-23-ui-copy-no-long-dashes.md), also indexed in
lessons.md and recorded as a standing rule in AGENTS.md.

## Follow-ups

The filed issues define future implementation. #122 and #123 can be picked up separately;
#124 first produces a specification for the existing D02/S3 direction. No date or architecture
was invented and S1 priority (D08) remains unchanged.
