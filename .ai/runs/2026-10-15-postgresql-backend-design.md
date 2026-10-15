---
title: Design the optional PostgreSQL backend (spec and ADR, no code)
date: 2026-10-15
agent: Claude Code / claude-opus-5-5 (one Plan subagent as sceptical reviewer)
trigger: Maintainer request — integration tests with PostgreSQL via testcontainers; maintainer chose "SQLite stays default, PostgreSQL as a second backend" and asked to review the design before implementation
status: completed
branch: docs/postgresql-backend-design
specs: [SPEC-117, SPEC-006, SPEC-012, ADR-0002, ADR-0009, ADR-0011]
---

# Run: Design the optional PostgreSQL backend

## Objective

Produce a reviewable design (SPEC-117, ADR-0011) for PostgreSQL as an optional second backend
next to the default SQLite, tested with testcontainers, before any implementation.

## Plan

1. Answer the maintainer's question "does `npx` work with Docker?" — yes, but only with Docker
   running; the maintainer chose a second backend.
2. Spike the query-builder options; write ADR and spec; have a second agent review them as a
   sceptical staff engineer; fold the findings in.

## Decisions

- Kysely instead of Drizzle (ADR-0011): one repository layer and one migration history for both
  dialects; Drizzle would need two schemas and two repository implementations.
- Delivery in four pull requests (ADR-0011 Consequences).
- The maintainer asked to review the design first; no implementation in this run.

## Work performed

- Spike (scratchpad, not committed): Kysely 0.29.6 on `node:sqlite` through an adapter and on
  PostgreSQL 17 via `@testcontainers/postgresql` 12.2.1 + `pg` 8.23.1 — identical results except
  driver value types (booleans 0/1 vs `boolean`, `count(*)` number vs string); container start
  about 5 s.
- Review findings incorporated: transactional SQLite migrations (Kysely's SQLite adapter does
  not declare transactional DDL), advisory lock in `withTransaction` on PostgreSQL, `COLLATE "C"`
  for identical ordering, `bigint` for sizes, pool connect timeout and error listener, URL
  redaction including query parameters, exit codes, async web database access, adoption of
  Drizzle-created SQLite databases inside the first migration, schema-equivalence test design,
  `pg` as a runtime dependency, Playwright wrapper script (webServer starts before globalSetup in
  Playwright 1.64.1), e2e support for both backends, test setup with Vitest projects.

## Verification

Design only. The spike script ran successfully against both backends. Nothing in the product
changed.

## Problems and deviations

None.

## Lessons recorded

None.

## Follow-ups

- Maintainer review of SPEC-117 and ADR-0011; then the four implementation PRs.
