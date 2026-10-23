---
title: App-authored UI copy must not use en or em dashes
date: 2026-10-23
tags: [ui, copy, conventions]
source: .ai/runs/2026-10-23-backlog-ui-workflows.md
---

# App-authored UI copy must not use en or em dashes

## Context

The maintainer explicitly prohibited en dash (U+2013) and em dash (U+2014) throughout the
application UI after reviewing the new design system and Artifacts table. Existing copy
uses them in mock/planned labels, separators and missing-value placeholders.

## Lesson

Use ordinary punctuation in app-authored UI copy: a colon, parentheses, a separate sentence,
or a normal hyphen where appropriate. This is now a standing rule in AGENTS.md. Existing
copy cleanup and its automatic prevention are deferred issues, not implemented in this run.

## How to apply

Check authored labels, messages, titles, accessible names and formatting fallbacks, including
Unicode escape forms. Preserve the exact content of imported artifacts, user data, raw
views, agent traces and benchmark evidence. Replacing characters in incoming or stored data
would violate those contracts. Do not confuse comments or documentation with UI literals.
