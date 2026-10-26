---
title: Verify text contrast throughout both themes
date: 2026-10-23
agent: OpenAI Codex
trigger: Maintainer asks about all text contrast after button verification
status: completed
branch: feat/shadcn-design-system
specs: [SPEC-119, SPEC-116]
---

# Run: Verify text contrast throughout both themes

## Objective

Check visible text, navigation, status labels and placeholders throughout existing demo
screens in light and dark modes. Fix measured failures without changing the preset accent.

## Plan

- [x] Audit current production screens and details in Chromium, compositing text and backgrounds.
- [x] Add failing regression coverage for semantic text colours and visible page content.
- [x] Adjust muted and status foreground tokens and remove reduced text opacity.
- [x] Verify all existing demo screens, status surfaces and placeholders in both themes.
- [x] Run quality gate, review changes, update spec, lessons and this log.

## Decisions

Preserve coloured status fills; introduce separate readable status text tokens. The existing
button-only checks do not establish text contrast across the app. Normal-size text needs
4.5:1; large text uses 3:1. Disabled controls are excluded from contrast requirements.

## Work performed

Initial audit: 28 page/theme combinations, 2,126 text occurrences and 89 failures.
Examples: light warning badge 2.66:1, success 4.02:1, muted 4.35:1; navigation planned text
with 80% opacity fails in both themes (dark active sidebar 4.29:1).
Independent read-only review also identified the light info badge as below threshold.
Added persistent browser scans and a matrix for every status variant and feedback text role
on background, card, muted, accent, destructive-tinted and warning-tinted surfaces.
Darkened light muted text, introduced separate success/warning/info foregrounds, reused the
accessible destructive foreground for standalone errors and removed navigation's reduced
text alpha. Status fill colours remain unchanged. Read-only review confirms no blockers.

## Verification

Initial browser report: `/tmp/directivebench-text-contrast-audit.json`.
| Check | Result |
| --- | --- |
| New text-contrast regression tests before fix | Both fail: 121 light / 2 dark occurrences, including fixture matrix |
| Targeted tests after fix | 2/2 pass; 1,244 occurrences/theme, minimum light 5.004:1 / dark 5.183:1 |
| Final `pnpm test:e2e --reporter=list,json` | 50/50 pass, no skips or flaky tests; 99.1 seconds |
| Text scans in full suite | 15 pages/theme plus semantic matrix; 1,439 occurrences/theme, zero failures; same minima |
| Independent production-browser rescan | 2,126 occurrences over 28 page/theme combinations; zero failures |
| `pnpm lint` | Pass |
| `pnpm typecheck` | All 7 tasks pass |
| `pnpm test` | 1,666 tests at 100% coverage; all 7 tasks pass (6 cached, web re-executed) |
| `pnpm build` | Web and CLI pass |
| `pnpm verify:pack` | Pass: clean install, demo, pages and clean server shutdown |
| Prettier / diff whitespace | Changed files formatted; diff check passes |

Final full report: `/tmp/directivebench-text-contrast-full-report.json`. Screenshots inspected:
`/tmp/directivebench-text-light.png` and `/tmp/directivebench-text-dark.png`.
Independent read-only review found no blockers. The scan checks seeded screens and one detail
per resource type, plus all badge variants and feedback text roles on six background classes.
It covers selected native form values and placeholders; operating-system select popups and
all possible imported-data states are not exhaustively audited. Group opacity calculation is
approximate, but no current enabled text uses it; disabled controls are excluded. Existing
button tests still cover label contrast on rest/hover/focus. This is not full WCAG certification.

## Problems and deviations

The first test draft had an extra parenthesis and an inferred DOM traversal type that needed
`Element | null`; fixed before verification. The existing Turbopack dynamic filesystem tracing
warning remains outside this styling change. No dependencies or product behavior changed.

## Lessons recorded

Extended [the preset accessibility lesson](../lessons/2026-10-23-verify-preset-button-accessibility.md)
and AGENTS.md: button-only checks do not prove contrast for the rest of the interface.

## Follow-ups

No required follow-up remains. No push, PR or merge requested.
