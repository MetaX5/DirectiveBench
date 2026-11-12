---
title: SPEC-125 Phase 1, missing occurrences (issue 21)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (implement SPEC-125 Phase 1, decisions D1 to D11 approved)
status: in-progress
branch: feat/missing-occurrences-phase-1
specs: [SPEC-125, SPEC-101, SPEC-102, SPEC-103, SPEC-105, SPEC-124]
---

# Run: SPEC-125 Phase 1, missing occurrences

Source doc: .ai/specs/2026-11-12-missing-occurrences-and-repository-removal.md

## Objective

Implement Phase 1 of SPEC-125 (issue 21, backlog E02-S03): a complete scan that finds at least
one artifact marks every active occurrence it did not find as `removed` (shown as "missing"),
except paths it could not observe; an empty scan marks nothing (A7 guard); a missing occurrence
found again is reactivated; the UI shows missing artifacts (artifact page Badge and note,
occurrence status, list Badge, scan result clauses, planned Badge and scan explanation) per the
maintainer's decisions D1 to D11 (§11.2). Acceptance criteria: SPEC-125 AC-1, AC-2, AC-4, AC-5,
AC-6, AC-7 (example import part), AC-8, AC-9 and AC-10 (first half). Phase 2 (repository
removal: AC-3, AC-7 removal part, AC-10 second half) is out of scope; no npm release between
the phases (§21).

## Plan

Goal: occurrences of deleted files become "missing" after a complete, non-empty scan, come back
when found again, and the UI says so, without ever marking on partial knowledge.

Scope: `packages/core` (discovery `unobserved`, `unseenOccurrencePaths`), `packages/database`
(`applyRepositoryScan` marking, reactivation count, scan result schema, `missing`/`lastFoundAt`),
`packages/runner` (pass `unobserved`, copy counts), `apps/web` (lib helpers, three pages,
stories, Detail view rule), Playwright, specs.

Non-goals: repository removal (Phase 2), move detection, a "Show removed" filter (issue 53),
cache deletion (issue 59), any release.

Risks: a marking bug could hide artifacts the user still has (mitigated by fail-closed
`unobserved` and the A7 guard, each pinned by tests); the shared e2e database must be left as
found (lesson 2026-11-10).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Decisions and core

- [ ] 1.1 Record UI decisions D1 to D11 in SPEC-125 §11.2
- [ ] 1.2 Core: DiscoveryResult.unobserved and unseenOccurrencePaths with tests

### Phase 2: Database and runner

- [ ] 2.1 Database: marking with the A7 guard, reactivation count, result schema, missing and lastFoundAt
- [ ] 2.2 Runner: pass unobserved and copy the counts, provider and failure-path tests

### Phase 3: Web

- [ ] 3.1 Web lib: describeScan clauses and warning kind, missingNote, occurrenceStatusLabel
- [ ] 3.2 Web pages, stories and the Detail view rule
- [ ] 3.3 Playwright: delete, rescan, restore, empty scan, contrast

### Phase 4: Verification and docs

- [ ] 4.1 Umbrella spec updates and SPEC-125 implementation status
- [ ] 4.2 Full gate, real-app run, browser QA, Codex review, run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
