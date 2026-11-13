---
title: An e2e registration fixture needs its own root, not a folder under one an earlier test registered
date: 2026-11-13
tags: [testing, e2e, playwright]
source: .ai/runs/2026-11-13-issues-215-216-row-names-and-unknown-filter.md
---

# An e2e registration fixture needs its own root, not a folder under one an earlier test registered

## Context

The issue 215 test in `apps/web/e2e/repositories.spec.ts` first put its two `skills` folders
under the spec's shared `sources` directory. It waited 30 seconds for "Registered skills (…)"
and timed out with the status still "Waiting for the runner…". The runner had answered; the
page asked "Register … anyway?" because an earlier test in the same file ("a path containing
registered repositories needs a confirmation") registers `sources` itself, so every new folder
under it overlaps a registered repository (FR-104-18). The Playwright message pointed at the
status line, not at the confirmation.

## Lesson

Repositories registered by earlier tests stay registered for the rest of the shared e2e
database, and a new path inside or around one of them needs a confirmation. A fixture that
expects a plain "Registered …" must not sit inside or contain any registered location.

## How to apply

Give each registration fixture its own root with `realpathSync(mkdtempSync(join(e2eTmpRoot(),
'<name>-')))`, remove it in `afterAll`, and when a registration seems stuck, read the
`error-context.md` snapshot for a "Register … anyway?" line before raising timeouts.
