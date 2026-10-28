---
title: A form with a React action resets to the defaultValue of the render that answers it
date: 2026-10-28
tags: [web, react, forms]
source: .ai/runs/2026-10-28-artifact-metadata-editing.md
---

# A form with a React action resets to the defaultValue of the render that answers it

## Context

The artifact editing forms (issue #64) post to Server Actions through `useActionState`. React 19
resets an uncontrolled `<form action={…}>` after every action, so a naive field loses what the
user typed when the server answers with an error, which the Form pattern forbids (rule 4).

## Lesson

The reset runs after the transition that carries the action's result has committed, so it
restores each field to the `defaultValue` of that new render. Returning the entered text in the
error state and rendering `defaultValue={state.kind === 'fieldError' ? state.value : saved}`
keeps the value after an error and clears (or shows the saved value) after a success, with no
controlled state and no `key` remount. `apps/web/e2e/artifact-metadata.spec.ts` asserts both.

Browsers also submit a textarea's line breaks as CR LF, while `maxLength` counts a line break as
one character: normalise to LF before the length check, or a text the field accepted is refused.

## How to apply

- For a Server Action form: return the submitted text in the error state and derive
  `defaultValue` from the state; do not make the field controlled to "keep" it.
- Normalise `\r\n?` to `\n` in the Zod schema before any length limit on textarea input.
- Prove both in Playwright: the value after an error, and the cleared or saved value after a
  success.
