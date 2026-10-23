---
title: Review shadcn generator output against the existing application
date: 2026-10-23
tags: [ui, shadcn, testing, fonts]
source: .ai/runs/2026-10-23-shadcn-design-system.md
---

# Review shadcn generator output against the existing application

## Context

Shadcn 4.22.1 initialization for preset `b3Rq8QfWi` replaced the app's `lib/utils.ts`
with a `cn` re-export, removing formatting helpers. It also added `next/font/google`,
duplicate animation CSS imports and new table cells with `whitespace-nowrap` that defeated
the existing `max-w-* break-words` cells. A browser assertion comparing the primary token's
OKLCH source string failed because production CSS optimization serialized it as Lab.

## Lesson

Generated code needs a compatibility review before use in an existing app. Preserve domain
helpers, status variants, heading semantics and native form behavior. Use locally bundled
fonts for offline builds and ship their license. Assert rendered colours rather than source
serialization, and verify that the selected font actually loads.

## How to apply

Inspect the complete diff after `shadcn init` and `apply`, including utilities and dependencies.
Restore existing helpers instead of adding a new `cn` dependency. Keep table body wrapping.
For Figtree 5.3.0, import `@fontsource-variable/figtree` (the package has no `latin.css`).
Run Playwright on the production build with asset failure tracking and loaded-font assertions;
compare colours via canvas pixels when CSS optimization can change their serialization.
Limit asset-failure assertions to static assets: Next.js intentionally aborts RSC prefetches
on reload. Concurrent Playwright runs need distinct `--output` paths as well as ports and
data directories; otherwise one run clears the other's trace files.
