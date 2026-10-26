---
id: SPEC-119
title: Shadcn preset design system
status: implemented
created: 2026-10-23
updated: 2026-10-23
category: feature
related: [SPEC-004, SPEC-116]
---

# SPEC-119 — Shadcn preset design system

## 1. Summary

Integrate the maintainer's shadcn preset `b3Rq8QfWi` into the existing web UI.
The maintainer approved applying the preset to existing screens on 2026-10-23.

## 2. Motivation and problem statement

The app has Tailwind 4 and source-owned primitives but no shadcn registry configuration.
Its hand-written neutral theme does not reflect the maintainer's selected design system.

## 3. Goals

Configure shadcn for `apps/web`, apply the selected preset, and use its components and
tokens on existing screens while preserving working flows and status meanings.

## 4. Non-goals

New product features, navigation redesign, database changes, and a public component gallery.

## 5. User stories

As a user, I see a consistent preset across dashboards, tables and forms in both themes.
As a contributor, I can add shadcn components using the project's configuration.

## 6. Functional requirements

1. `apps/web/components.json` MUST configure aliases, Tailwind CSS and the selected preset.
2. Shared buttons, badges, cards and tables MUST adopt the preset; existing imports MAY
   remain as compatibility exports. Preserve heading semantics and native form behavior.
3. Existing visible form controls MUST use shared preset styling; selects MUST remain native.
4. Domain badges MUST retain labelled success, warning, info, muted and destructive states.
5. System theme selection and the persistent light/dark toggle MUST continue to work.
6. Enabled buttons MUST use a pointer cursor; text MUST meet WCAG AA 4.5:1 contrast in
   rest, hover and focus states in both themes. Button labels may override the preset's
   foreground tokens to meet this requirement. Inline form submit buttons MUST match
   the adjacent input height (32 CSS pixels).
7. Long badges MUST wrap without clipping or horizontally expanding a 390px mobile viewport.
8. All visible text, including muted descriptions, navigation labels, semantic statuses,
   errors and placeholders, MUST meet WCAG AA in both themes: 4.5:1 for normal text,
   3:1 for large text. Check actual background surfaces, including tinted badges and active
   navigation. Disabled controls are excluded; status fills may use separate text tokens.

## 7. Non-functional requirements

No runtime external font, CSS or script requests. Fonts selected by the preset MUST be
bundled locally. Preserve server rendering, responsive navigation and keyboard focus.

## 8. Domain entities and contracts

No domain changes. Preserve the native props and variants consumed by existing pages.

## 9. Data flow

Unchanged: web reads SQLite through repositories and queues jobs; styling adds no data flow.

## 10. API and interface design

Source-owned components live in `apps/web/components/ui`. Existing `primitives` exports
remain compatible. CLI commands and server actions are unchanged.

## 11. UI/UX considerations

Apply preset colours, radius, typography and component styling. Keep compact density,
honest mock/planned labels, dark/light mode and horizontally scrollable tables.

## 12. Security considerations

No new command execution in the web app. Registry generation is a development operation.
No remote assets at runtime; follow [local-first ADR](../../decisions/0001-local-first-architecture.md).

## 13. Error handling

Existing form validation and application errors remain unchanged and visible.

## 14. Edge cases

Native filter submission, invalid input, disabled controls, long table content, small screens,
theme persistence after reload and domain badge colours in both themes.

## 15. Testing strategy

Use Playwright against the built CLI and seeded mock demo for computed preset styling,
theme switching/persistence, native filters, responsive navigation and no remote requests.
Run lint, typecheck, full 100% unit coverage, build, verify:pack and the full E2E suite.

## 16. Acceptance criteria

- [x] AC-1: Shadcn configuration, accent palette and typography match preset `b3Rq8QfWi`, with accessible foreground overrides.
- [x] AC-2: Existing shared components and visible form controls use the design system.
- [x] AC-3: Both themes, theme persistence and native form flows pass browser tests.
- [x] AC-4: Built app assets, including fonts, load locally without remote requests.
- [x] AC-5: All required quality gates pass and the packed CLI serves the styled app.
- [x] AC-6: Button contrast, pointer cursors, 32px form alignment and mobile badge wrapping pass browser checks.
- [x] AC-7: All visible text on existing demo pages and status foregrounds pass contrast checks in both themes.

## 17. Dependencies

Existing Tailwind 4, React 19, Next.js 16, next-themes, CVA and tailwind-merge.
Only add packages required by generated components and local preset fonts.

## 18. Open questions

None; maintainer approved the integration scope.

## 19. Future extensions

Additional shadcn components as concrete features require them.

## 20. Implementation status

Follow-up verified on 2026-10-23: the maintainer requested verification of all text, extending
button checks. Muted text, navigation, semantic statuses, errors and placeholders now pass
checks in both themes. See [text contrast run](../../runs/2026-10-23-text-contrast.md).

Implemented and verified on 2026-10-23 (Linux, Node 22.22.1):

- `components.json` configures radix-lyra with neutral tokens and lime accent. Source-owned
  buttons, badges, cards, tables, inputs and native selects are used by existing screens.
- Figtree is bundled from Fontsource and its OFL license ships with the web assets.
- The accent fills are unchanged; primary, link and destructive label foregrounds have explicit
  accessibility overrides. All six button variants pass 4.5:1 in rest, hover and focus states
  in both themes (measured minimum 5.81:1). Register and Input are both 32px.
- Playwright: 50/50 tests pass, including four design-system and two text-contrast tests; both themes, loaded font
  faces, local assets, native forms, mobile width and cursor feedback are verified.
- Lint, typecheck, 1,666 unit tests at 100% coverage, build and verify:pack pass. A browser
  smoke check of the installed tarball verifies locally loaded Figtree, cards, font license,
  no remote requests, pointer cursor and 32px form alignment.
- All measured text on 15 pages per theme plus the semantic surface matrix passes AA:
  1,439 occurrences per theme, no failures, minimum 5.004:1 light and 5.183:1 dark.
  Source-owned status fills are preserved; readable success/warning/info foreground tokens
  and opaque navigation labels fix failures found by the initial wider audit.
- Independent review findings (table wrapping, palette/font assertions and mobile badges)
  were addressed; dark/light and mobile screenshots were inspected.

Contributor workflow: run `pnpm dlx shadcn@latest add <component>` from `apps/web`.
The original preset is `b3Rq8QfWi`. Review generator diffs before reapplying it: utilities,
local font imports and accessible foreground overrides must be preserved.

Not verified: other browsers, Windows/macOS and a full WCAG audit (the button checks cover
text contrast on seeded pages and representative surfaces, not a certification of every
control, native operating-system popup or focus indicator).
