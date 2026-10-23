---
title: Apply shadcn design system preset
date: 2026-10-23
agent: OpenAI Codex
trigger: Maintainer request and scope approval
status: completed
branch: feat/shadcn-design-system
specs: [SPEC-004, SPEC-116, SPEC-119]
---

# Run: Apply shadcn design system preset

## Objective

Apply preset `b3Rq8QfWi` to the existing web screens, preserving product behavior and local assets.

## Plan

- [x] Inspect CLI preset output and configure `apps/web/components.json`.
- [x] Add browser regression checks before implementation; prove their initial failure.
- [x] Apply the preset and generate button, badge, card, table and native form components.
- [x] Adapt existing primitives and visible forms, retaining native props, heading semantics,
      domain status variants and compact layout. Bundle selected fonts locally.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm verify:pack`,
      and `pnpm test:e2e`; inspect real browser screenshots and review the diff.
- [x] Finalize specs, lessons and this run with actual evidence and outstanding limitations.

## Decisions

Keep existing primitive imports as compatibility exports; preserve native selects and domain
status variants. The preset controls visual tokens; existing product behavior is retained.
Read-only independent review checks compatibility and packaging risks.

## Work performed

Read project instructions, relevant specs, current UI, and shadcn apply documentation.
Created feature branch `feat/shadcn-design-system`.
Initialized shadcn 4.22.1 and applied `b3Rq8QfWi` from `apps/web`; generated six components.
Restored the app's utility helpers overwritten by initialization, removed the unnecessary
`cn` dependency, and moved shadcn to devDependencies for its Tailwind utilities. Replaced
Google font downloads with local Fontsource Figtree plus its license.
Adapted the primitive compatibility exports, preserved semantic h3/p tags, domain statuses,
native filters, existing actions and compact layout. Independent review caught table nowrap
and weak palette/font assertions; both were fixed.
After the maintainer's screenshot feedback, fixed shared button cursors and readable label
foregrounds, matched Register/Input height, and added permanent guidance in AGENTS.md.
Long badges now wrap within PageHeader actions on mobile. Using writing-plans and verification-before-completion
skills; this run log stores the implementation plan as required by AGENTS.md.

## Verification

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | All 7 tasks pass |
| `pnpm test` | All 7 tasks pass; 1,666 tests, 100% statements/branches/functions/lines; 6 tasks cached, web 206 tests executed |
| `pnpm build` | Web and CLI pass |
| `pnpm verify:pack` | Pass: clean install, demo, HTTP routes, Host protection, clean shutdown |
| `pnpm test:e2e --reporter=list,json` | 48/48 pass, 0 skipped/flaky; 86.5 seconds |
| Targeted design-system tests | 4/4 pass |
| Browser smoke against installed tarball | Pass: Figtree loaded locally, cards render, OFL license HTTP 200, no external requests; Register/Input both 32px and pointer cursor |
| Prettier and `git diff --check` | Pass on changed files |

Red-first evidence: original UI failed the new Button/Input slot assertions. Mobile test
reproduced 552px document width at a 390px viewport. Before accessibility fixes, Button
cursor assertions received `default`; destructive text measured 3.97:1 at rest / 3.31:1 on
light hover and 4.35:1 on dark hover. The initial broad red test hit its 30s timeout because
soft cursor checks waited 5s each; these waits were bounded to 500ms for useful diagnostics.

Final contrast checks use the real six Button variants in the production page, composite
translucent backgrounds, and compare WCAG luminance for rest/hover/focus in both themes.
Minimum observed ratios: primary 11.55:1 light / 5.97:1 dark; destructive 5.81:1 light /
6.55:1 dark; every other variant exceeds 8:1. Checked dark/light desktop, mobile and packed
form screenshots visually. Browser artifacts remain in ignored `apps/web/test-results`;
JSON report at `/tmp/directivebench-shadcn-e2e-report.json`, packed form screenshot at
`/tmp/directivebench-shadcn-register-dark.png`.

Not verified: Windows/macOS, browsers other than Chromium, and a full accessibility audit.

## Problems and deviations

Sandbox makes `.git` and pnpm cache read-only; approved escalated commands were used.
The generator added duplicate CSS imports and replaced utils.ts; reviewed and restored.
Figtree 5.3.0 exports the root CSS, not `latin.css`; corrected the import after build evidence.
CSS optimization converts OKLCH to Lab, so browser checks compare rendered pixels. Next.js
cancels RSC prefetches on reload; only failed static assets count in the font/asset check.
One parallel targeted browser run initially shared Playwright's output directory and removed
the full run's trace; subsequent parallel probes used explicit separate `--output` directories.
All final runs passed. The existing Turbopack warning about dynamic filesystem tracing in
`claude-code/ancestor-inspection.ts` remains outside this UI change.

Re-planning: maintainer feedback added explicit button contrast/cursor/height requirements;
visual inspection added mobile badge wrapping. These were implemented and verified before
completion. Preset accent fills remain unchanged; accessible foreground tokens are intentional.

## Lessons recorded

- [Review shadcn generator output](../lessons/2026-10-23-shadcn-generators-need-a-compatibility-review.md).
- [Verify preset button accessibility](../lessons/2026-10-23-verify-preset-button-accessibility.md) — maintainer correction also recorded in AGENTS.md.

## Follow-ups

No required work remains. Changes are kept on the feature branch; no push, PR or merge was requested.
