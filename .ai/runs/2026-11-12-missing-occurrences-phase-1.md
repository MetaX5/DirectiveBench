---
title: SPEC-125 Phase 1, missing occurrences (issue 21)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (implement SPEC-125 Phase 1, decisions D1 to D11 approved)
status: completed
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

PR: #214

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Decisions and core

- [x] 1.1 Record UI decisions D1 to D11 in SPEC-125 §11.2 — 595a41d
- [x] 1.2 Core: DiscoveryResult.unobserved and unseenOccurrencePaths with tests — 74d14e3

### Phase 2: Database and runner

- [x] 2.1 Database: marking with the A7 guard, reactivation count, result schema, missing and lastFoundAt — b471349
- [x] 2.2 Runner: pass unobserved and copy the counts, provider and failure-path tests — b99c018

### Phase 3: Web

- [x] 3.1 Web lib: describeScan clauses and warning kind, missingNote, occurrenceStatusLabel — 1bdc0e8
- [x] 3.2 Web pages, stories and the Detail view rule — 1bdc0e8
- [x] 3.3 Playwright: delete, rescan, restore, empty scan, contrast — 81a2f7f

### Phase 4: Verification and docs

- [x] 4.1 Umbrella spec updates and SPEC-125 implementation status — 9541345
- [x] 4.2 Full gate, real-app run, browser QA, Codex review, run log — 5321431

## Decisions

- Recorded the maintainer-approved UI decisions D1 to D11 as SPEC-125 §11.2 and corrected §11
  (empty-scan line is `text-warning-foreground`, D6b; planned Badge colon form, D7; scan
  explanation without em dashes, D8).
- `unseenOccurrencePaths` returns nothing when an unobserved path is `''` or `.` (the whole
  location was not observed), and treats a root-skill occurrence (`''`) as containing every
  unobserved path, as FR-125-03 says.
- The multi-repository `lastFoundAt` case is tested by pointing a second occurrence at the same
  artifact in SQL: scans never share an artifact across repositories (location identity), so no
  public writer produces it yet.
- Issue 21 also covers repository removal (Phase 2), so the PR says `Refs #21`, not `Closes`.

## Work performed

1. `39ebba0` plan; `595a41d` SPEC-125 §11.2 decisions.
2. `74d14e3` core: `DiscoveryResult.unobserved`, `unseenOccurrencePaths`.
3. `b471349` database: marking with the A7 guard, reactivation count, scan result counts,
   `missing`/`lastFoundAt`.
4. `b99c018` runner: pass `unobserved`, copy the counts; local, `local-git` and hosted tests.
5. `1bdc0e8` web: scan clauses and `warning` kind, `missingNote`, `occurrenceStatusLabel`,
   artifact page Badge and note, list cell Badge, planned Badge, scan explanation, stories and
   the Detail view rule.
6. `81a2f7f` Playwright: `missing-occurrences.spec.ts` and the D11 contrast addition.
7. `9541345` umbrella specs (SPEC-101, 102, 103, 105) and SPEC-125 §20 and ACs.
8. `5321431` run log and lesson; PR #214 marked ready with labels.
9. `om-auto-review-pr 214` (engine `om-code-review`): approve, posted as a COMMENT (self-review), one nit fixed in `b9156c1`.
10. `om-auto-qa-pr 214`: PASS, screenshots posted on the PR (scan lines as element screenshots, so no local paths appear).

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | 7/7 packages pass, 100% statements, branches, functions and lines in each |
| `pnpm build` | pass |
| `pnpm verify:pack` | "Packaging verification passed" |
| `pnpm test:e2e` | 148 passed |
| `pnpm test:storybook` | 68 files, 308 tests passed (both themes, axe) |

- Red first: `packages/database/test/missing-occurrences.test.ts` against `main`'s
  `artifacts.ts` failed 6 of 10 tests (marking, A7, unobserved, reactivation, `lastFoundAt`,
  batches); the 4 that passed pin behaviour that already held (example import, cancelled scan,
  rollback, schema defaults once the schema change is in place).
- NFR-125-02: marking 10,000 occurrences (with inserting them) took 84 ms in that test.
- Real app: `sh .ai/scripts/test-env-up.sh` (built CLI, demo data, mock agent only) and an
  exploratory browser QA agent (agent-browser) on a plain-folder fixture: register, scan,
  delete a skill ("1 no longer found (marked missing)."), list Badge, artifact page Badge, note
  and every tab, restore ("1 found again."), empty scan (warning line, nothing marked), planned
  Badge and scan explanation; keyboard order, both themes, 320px (no page scroll), console clean,
  no en or em dash in the new copy, computed contrast at least 5.5:1 for every new element. No
  findings.
- Codex adversarial review (`--scope branch --base main`): round 1 needs-attention with no
  findings (it could not run the gates); round 2, given the gate results, approve with no
  material findings.

**Not verified:** screen-reader announcements; the real-app run used a plain folder only (Git
and GitHub providers are covered by runner tests, not the browser); the light-theme value of the
green scan line was not computed by the QA agent (unchanged token pair, 7.04 in the decision
document).

## Problems and deviations

- Playwright expected Chromium 1254 while 1248 was installed locally; `npx playwright install
  chromium chromium-headless-shell` into `~/.cache/ms-playwright` fixed it (nothing committed).
- A first e2e run with `TMPDIR` inside the worktree registered the worktree itself, because the
  fixture lay inside a git work tree (known: lesson 2026-10-30); the runs used `/var/tmp`.
- The first Codex run reviewed only the uncommitted run log (lesson below).
- No deviation from SPEC-125 or D1 to D11.

## Lessons recorded

- [Pass `--scope branch --base main` to the Codex adversarial review](../lessons/2026-11-12-codex-review-scope-follows-the-working-tree.md)

## Follow-ups

- SPEC-125 Phase 2 (repository removal) before the next npm release (§21: both phases ship in
  one release; do not release in between).
- Move detection (FR-103-09) and the "Show removed" filter (issue 53) stay open.
