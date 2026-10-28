---
title: Pixel comparisons of the web UI need the same data-directory path in both runs
date: 2026-10-28
tags: [ui, testing, screenshots]
source: .ai/runs/2026-10-28-design-token-migration-and-guard.md
---

# Pixel comparisons of the web UI need the same data-directory path in both runs

## Context

During the SPEC-121 token migration, before/after screenshots of the demo pages differed only
on `/settings`. The page prints the resolved data directory, and the "after" server ran from a
copy of the seeded directory at a different path.

## Lesson

With the same seeded database, the same data-directory path and a fixed Playwright clock, the
demo pages render byte-identical PNGs across runs. Any path difference shows up on `/settings`.

## How to apply

Seed once with `directivebench --data-dir <seed> demo`. Before each screenshot run, copy the
seed to the same path (for example `<scratch>/d1`), serve from there, and use
`page.clock.setFixedTime`. Check determinism by taking the "before" set twice before
migrating. Stop the server with a pattern that cannot match your own shell (see the `pkill -f`
note in the testing lesson).
