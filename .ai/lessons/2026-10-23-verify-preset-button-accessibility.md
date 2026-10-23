---
title: Verify preset button contrast, cursors and form alignment
date: 2026-10-23
tags: [ui, accessibility, shadcn]
source: .ai/runs/2026-10-23-shadcn-design-system.md
---

# Verify preset button contrast, cursors and form alignment

## Context

The maintainer flagged faint text, missing pointer cursors and a Register button shorter
than its adjacent input after the Lyra preset was applied. The generated small button is
28px high while Input is 32px; the preset does not add pointer cursors automatically.

## Lesson

A generated preset is a starting point. Measure enabled button label contrast against the
rendered background in both themes and in rest, hover and focus states. Normal-size labels
need at least 4.5:1 ([WCAG 1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)).
Keep pointer feedback and match the sizes of adjacent form controls.

## How to apply

Use the shared Button for cursor and contrast fixes. Preserve the accent palette while
choosing readable foreground tokens. Use the default 32px button next to the 32px Input;
reserve smaller buttons for dense rows. Verify computed colours (compositing transparent
backgrounds), hover and focus styles, and bounding-box heights in Playwright.
The standing rule is also recorded in AGENTS.md.

## Follow-up: text outside buttons

The maintainer then asked about all text in light and dark modes. A broader production
audit found 89 failing occurrences over 28 page/theme combinations: light warning badges
2.66:1, success 4.02:1, muted 4.35:1, and reduced-opacity navigation labels failing in both
themes. Passing button tests does not establish contrast for descriptions, statuses or forms.

Use distinct status foreground tokens instead of reusing the brighter fill colour for text.
Test normal text and placeholders against actual surfaces, including muted backgrounds,
active navigation and tinted regression rows. The regression tests now cover visible pages
and a matrix of all badge variants and feedback text roles across six surface classes.
