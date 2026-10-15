---
title: Adopt engineering standards from an external document, adapted to this codebase
date: 2026-10-15
agent: Claude Code / claude-opus-5-5 (one read-only Explore subagent for the codebase survey)
trigger: Maintainer request — "implement the engineering standards in .ai/docs/engineering-standards.md, but they must be compatible with our code; they come from an outside person"
status: completed
branch: docs/engineering-standards
specs: [SPEC-003, SPEC-004, SPEC-007, SPEC-008, SPEC-012, SPEC-014]
---

# Run: Adopt engineering standards (adapted)

## Objective

Adopt the engineering standards from an external document
(`.ai/docs/2026-09-01-engineering-standards.md`, untracked) only where they are compatible with
DirectiveBench's code and specs. Acceptance: every adopted rule is restated for this codebase,
nothing contradicts an existing spec or ADR, automatable rules are enforced, and the quality gate
passes.

## Plan

1. Read the external document and survey the actual conventions (web mutations, fetch usage,
   components, auth, error classes, swallowed errors, console, `any`, magic numbers, boolean
   arguments, lint config, DB access and transactions, CI, Zod boundaries).
2. Fit-gap: keep generic rules, map stack-specific intents to our equivalents, reject the rest
   with reasons.
3. Write the result as a foundation spec (not as a new `.ai/docs/` directory, which `AGENTS.md`
   §1 does not allow), summarise in `AGENTS.md`, enforce what lint can enforce cheaply.

## Decisions

- **The external document describes a different product** ("DevMentor": a booking marketplace
  on MikroORM, `awilix`, JWT cookies, Stripe, packages `app/core/db/ui`). Its structure,
  migration steps and `AGENTS.md`/`product-scope.md` edits were not applied; rejected rules are
  listed with reasons in SPEC-014 Appendix A.
- **Spec, not a docs folder:** standards live in `.ai/specs/2026-10-15-engineering-standards.md`
  (SPEC-014, draft). The external file stays untracked and is not committed.
- **Envelope conflict resolved in favour of SPEC-008** — the external `{ ok, data }` HTTP envelope
  was not adopted.
- **Enforcement added only where it is cheap and already true:** ESLint `no-restricted-imports`
  for the SPEC-003 dependency direction (closes the "convention only; no automated check" gap)
  and `no-console` outside the CLI. Existing deviations were documented (SPEC-014 §11) rather
  than refactored, to keep the change focused.

## Work performed

1. Codebase survey (Explore subagent, read-only).
2. `eslint.config.mjs`: per-package boundary rules, web-app rules (no runner, no engine root or
   orchestrator, agent adapters detection-only, no Drizzle/`node:sqlite`/`child_process`),
   `no-console` for `packages/*/src` and `apps/web`.
3. SPEC-014 Engineering Standards + index entry; SPEC-003 enforcement text and implementation
   status updated.
4. `AGENTS.md` §5 and §7 summary pointing to SPEC-014.
5. Lesson on `no-restricted-imports` negation semantics.

## Verification

- `pnpm format:check` — pass. `pnpm lint` — pass (0 problems on the existing code).
- `pnpm typecheck` — 7/7 tasks successful. `pnpm test` — 95 tests passed (core 36,
  benchmark-engine 31, agent-adapters 8, database 7, runner 6, cli 7).
- Rule probes: temporary files with forbidden imports in `apps/web/lib`,
  `packages/benchmark-engine/src` and `packages/core/src` produced 13 expected errors, and a
  `console.log` in `core` one more; allowed
  engine subpaths and a type-only import from `agent-adapters` produced none. Probe files were
  deleted.
- Not run: `pnpm build`, `pnpm verify:pack`, `pnpm test:e2e` — no application, packaging or UI
  code changed (only lint configuration and documentation).

## Problems and deviations

- The first boundary rule used `group` negations and flagged the allowed engine subpaths; fixed
  by switching to the `regex` option (lesson below).
- The user referred to `.ai/docs/engineering-standards.md`; the only file present is
  `.ai/docs/2026-09-01-engineering-standards.md`, which was used.

## Lessons recorded

- [no-restricted-imports group negations cannot re-include a subpath](../lessons/2026-10-15-eslint-restricted-import-negation.md)

## Follow-ups

- Fix the deviations in SPEC-014 §11 (named constants for timeouts/limits, the boolean helper in
  `assertions.ts`, cast comments in `client.ts`, typed server-action results with a shared error
  rendering, Zod for frontmatter and CLI flags) in focused changes.
- Maintainer review of SPEC-014 (status stays `draft`).
