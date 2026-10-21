---
title: Triage the first CodeQL alerts and fix the two ReDoS findings
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request (review CodeQL alerts after enabling code scanning)
status: completed
branch: fix/codeql-redos
specs: [SPEC-102, SPEC-007]
---

# Run: Triage the first CodeQL alerts and fix the two ReDoS findings

## Objective

Review the six alerts CodeQL raised on its first scan of `main`: fix the real ones with
regression tests, dismiss the false positives with a reason.

## Plan

Read each flagged line, measure the regex alerts with the reported input shapes, check whether
the input can reach the reported size, then fix or dismiss.

## Decisions

| Alert | Rule | Location | Outcome |
| --- | --- | --- | --- |
| #6 | `js/polynomial-redos` | `core/src/redact.ts` private-key block | **Fixed**: quadratic; command output reaches 10 MiB (`maxOutputBytes`), ~30 min. |
| #5 | `js/polynomial-redos` | `core/src/artifacts.ts` `extractReferences` | **Fixed**: quadratic; a primary file reaches 1 MiB, ~7 min for `[` × 1 MiB. |
| #4 | `js/polynomial-redos` | `core/src/artifacts.ts` `firstHeading` | Dismissed (false positive): measured < 1 ms at 50 000 characters; it can fail at one start only. |
| #3 | `js/shell-command-constructed-from-input` | `runner/src/hosted-git.ts` | Dismissed (false positive): argv for `spawn` with `shell: false`; `protocol` is a typed union. |
| #2 | `js/shell-command-injection-from-environment` | `runner/src/git-process.ts` | Dismissed (false positive): `shell: false`; git is resolved on absolute `PATH` entries only. |
| #1 | `js/incomplete-sanitization` | `core/test/frontmatter.test.ts` | Dismissed (used in tests): the fixture key has exactly one tab. |

- `extractReferences`: the link text excludes `[` and the target excludes `](`, so a candidate
  ends where the next starts. Targets with brackets (`app/[id]/page.tsx`) are still extracted;
  compared with the old pattern on nested, broken and bracketed links, only the malformed
  `[a](b](c)` differs (old `b](c`, new nothing).
- `redactSecrets`: private-key blocks are found with two `exec` calls and the scan stops at the
  first BEGIN without an END; the output is identical to the old global replace.

## Work performed

- `fix(core): make private-key redaction and reference extraction linear` with regression tests.
- Alerts #1–#4 dismissed through the API with the reasons above. #5 and #6 close when CodeQL
  scans `main` after the merge.

## Verification

- New references: 1 MiB of `[` in 3 ms, 1 MiB of `[](!` in 9 ms; redaction of 10.8 MB of BEGIN
  markers well inside the 10 s test bound. The new tests hung on the old code (killed after
  150 s).
- `pnpm --filter @directivebench/core test`: 245 passed, 100% coverage. `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`: all pass.
- Not verified: that CodeQL closes #5 and #6 (happens after merge).

## Problems and deviations

The first CI attempts were red because of two unrelated flaky timing tests; fixed separately in
PR #82 (`.ai/runs/2026-10-21-flaky-timing-tests.md`).

## Lessons recorded

- [A regex for a delimited span must not match its own opening delimiter inside](../lessons/2026-10-21-delimited-span-regex-must-exclude-its-opener.md)

## Follow-ups

- `firstHeading`'s `\s+` also crosses newlines (`#\n\nfoo` gives the heading `foo`); harmless,
  not changed here.
