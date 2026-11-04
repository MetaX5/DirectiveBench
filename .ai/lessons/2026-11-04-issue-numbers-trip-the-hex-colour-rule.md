---
title: A three-digit issue number in an app comment trips the hex-colour token rule
date: 2026-11-04
tags: [testing, design-system, web]
source: .ai/runs/2026-11-04-issue-171-outline-button-border.md
---

# A three-digit issue number in an app comment trips the hex-colour token rule

## Context

During #171 a code comment `// #171 (tokeny.md U14)` in `components/ui/button.stories.tsx` and
`stories/blocks/contrast.tsx` failed `pnpm test` with "hex colour; use a semantic token (D2)".
The rule in `apps/web/test/design-tokens.test.ts` scans every line of `.ts`/`.tsx` files in the
design-system scope (comments included) for `#[0-9a-fA-F]{3}` or `{6}`, so `#171`, `#123` or
`#abc` reads as a colour. MDX files are checked only on their `className` values, so the same
text in a `.mdx` page passes.

## Lesson

Inside the design-system scope (`apps/web/design-system-scope.json`), refer to issues and PRs in
`.ts`/`.tsx` comments as "issue 171" or "PR 180", never `#171`. Do not loosen the rule: it
catches real hex values.

## How to apply

Write "issue NNN" in comments under `apps/web/app`, `components`, `stories` and `.storybook`; files outside
the scope (`e2e/`, `test/`) may keep `#NNN`. Run
`pnpm --filter @directivebench/web exec vitest run test/design-tokens.test.ts --coverage.enabled=false`
after adding comments there.
