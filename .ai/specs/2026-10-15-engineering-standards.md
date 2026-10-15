---
id: SPEC-014
title: Engineering Standards
status: draft
created: 2026-10-15
updated: 2026-10-15
category: foundation
related: [SPEC-003, SPEC-004, SPEC-006, SPEC-007, SPEC-008, SPEC-012, ADR-0003, ADR-0006, ADR-0008]
---

# SPEC-014 — Engineering Standards

## 1. Scope and provenance

The coding, architecture, security and review rules every change to DirectiveBench follows,
whether written by a human or an AI agent. [`AGENTS.md`](../../AGENTS.md) summarises them and
points here.

The rules were adapted from an external engineering-standards document written for a different
product (a web marketplace built on MikroORM, `awilix` and cookie-based JWT authentication).
Only the rules that fit DirectiveBench's architecture were adopted, each restated in terms of
this codebase. [Appendix A](#appendix-a--rules-not-adopted-from-the-external-document) lists what
was not adopted and why, so it is not re-proposed by accident.

This spec does not redefine topics owned by other specs; it links to them:
architecture and dependency direction — [SPEC-003](2026-10-14-system-architecture.md);
dependency policy — [SPEC-004](2026-10-14-technology-stack.md);
security controls and command execution — [SPEC-007](2026-10-14-security-and-privacy.md);
server actions, `/api` and the error envelope — [SPEC-008](2026-10-14-api-architecture.md);
tests and CI — [SPEC-012](2026-10-14-testing-strategy.md). On those topics the linked spec wins.

## 2. Naming

Conventions as they exist in the code today. New code follows them.

| Element | Convention | Example |
| --- | --- | --- |
| Package | `packages/<name>` or `apps/<name>`, scoped `@directivebench/<name>`; only the CLI is published as `directivebench` | `@directivebench/benchmark-engine` |
| Source file | kebab-case `.ts` / `.tsx` | `artifact-loader.ts`, `auto-refresh.tsx` |
| React component | PascalCase function exported from a kebab-case file | `EmptyState` in `components/common.tsx` |
| Next.js page | `app/<segment>/page.tsx`, default export | `app/executions/page.tsx` |
| Server action | camelCase verb + noun + `Action`, in `apps/web/lib/actions.ts` | `cancelJobAction` |
| Zod schema | camelCase + `Schema`, defined once next to the type it validates | `configSchema`, `benchmarkJobPayloadSchema` |
| Domain error | PascalCase + `Error`, `extends Error` with `override name`, declared in the package that throws it | `PathEscapeError`, `ConfigError` |
| Constant | `SCREAMING_SNAKE_CASE`; durations carry a unit suffix | `DEFAULT_PORT`, `DEFAULT_KILL_GRACE_MS` |
| Database table / column | snake_case; tables plural ([SPEC-006](2026-10-14-database-schema.md)) | `benchmark_suite_versions.execution_approved_at` |
| Record ID | `createId(prefix)` → `<prefix>_<random>` ([SPEC-006](2026-10-14-database-schema.md)) | `job_…`, `artv_…` |
| Test file | `test/<area>.test.ts` per package (Vitest); Playwright in `apps/web/e2e/` | `packages/core/test/config.test.ts` |

## 3. Architecture rules

1. **Dependency direction is enforced, not just documented.** Packages import only what
   [SPEC-003 §2.1](2026-10-14-system-architecture.md#21-allowed-dependency-directions) allows. The
   ESLint `no-restricted-imports` configuration in `eslint.config.mjs` encodes it (§9). Loosening
   a boundary is an architecture change: update SPEC-003 (and add an ADR) in the same change.
2. **Persistence goes through repositories.** Only `@directivebench/database` uses Drizzle or
   `node:sqlite`. The web app and the runner call repository functions; nobody else writes SQL
   ([SPEC-008 §2](2026-10-14-api-architecture.md#2-principles)).
3. **The web process never executes benchmarks or processes.** It validates input, reads through
   repositories and enqueues jobs; the runner in the CLI process executes them.
4. **Validate at the boundary, once.** External input (config files, benchmark YAML/JSON, form
   data, job payloads, future `/api` bodies) is parsed with a Zod schema before use. A schema is
   defined once — domain-level schemas in `core` or in the owning package (e.g. the benchmark
   definition in `benchmark-engine`) — and imported by every consumer, never redefined.
5. **Use the parsed output, never the raw input.** Code that persists or acts on input uses the
   object returned by the schema, so unknown fields (an `id`, a `status`, an approval timestamp)
   cannot be smuggled in. Never spread `FormData`, a request body or a raw YAML object into a
   repository call.
6. **Integrations sit behind a contract.** Agent CLIs are reached through the `AgentAdapter`
   contract and, later, model APIs through model providers
   ([ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md)). Vendor SDKs and CLI
   specifics stay inside their adapter; callers see only the contract.
7. **Check-then-act on shared state is atomic.** When a decision depends on state another
   process can change (job status, snapshot existence), use a single conditional statement
   (`acquireNextJob`'s `UPDATE … RETURNING`, `requestJobCancellation`'s status-guarded updates)
   or `withTransaction`. A read followed by a separate unconditional write is only acceptable when
   the data read is immutable (artifact and suite versions are never modified or deleted).
8. **Explicit wiring, no auto-discovery.** Adapters, commands and repositories are registered by
   explicit imports and lists (`CLI_AGENTS`, the commander program). Nothing is discovered by
   scanning folders, and imported repositories are never executed automatically.
9. **No speculative structure.** A package, folder, abstraction or option is created when it has
   real code and a consumer ([ADR-0003](../decisions/0003-monorepo-architecture.md)). Planned
   features stay in specs and are visibly marked as planned in the UI.

## 4. Engineering principles

When two principles conflict, prefer the one that keeps the change smaller and more explicit.

- **Single responsibility.** A server action validates, calls repositories and redirects or
  revalidates; business rules it needs (e.g. `executionBlockers`) live in the owning package and
  are shared with the runner, not re-implemented in the action.
- **DRY, with judgement.** One definition per schema, rule and constant; extract a copied block
  that contains branching logic. Three similar lines are fine.
- **Separation of concerns.** Domain packages do not import Next.js or React; pages do not issue
  queries; the engine does not know about the database or job state.
- **Dependency inversion.** Depend on contracts (`AgentAdapter`, `RunnerLogger`, injected clocks
  and IDs in tests), not on concrete vendors or global state.
- **Composition over inheritance.** Prefer small functions and objects composed together over
  class hierarchies. Error subclasses are the expected exception.
- **Fail closed.** An error inside a safety decision denies: unknown `Host` → 403, unapproved or
  unparseable suite → not executable, path that cannot be proven inside its root → rejected.
  Never fall through to "allow" because a check threw.
- **Idempotency where retries happen.** Operations that can be repeated (imports of the same
  snapshot, migrations, job acquisition, shutdown) must be safe to run twice.
- **Honesty.** Mock results are labelled as mock, `local-process` runs as "Not sandboxed", and
  unimplemented features as planned (`AGENTS.md` §7).

## 5. Security minimums

[SPEC-007](2026-10-14-security-and-privacy.md) is normative; these are the review-level rules.

1. Untrusted input never reaches a query, command or file path unparameterised or
   uncanonicalised: SQL through Drizzle with bound parameters (no `sql.raw` with input); commands
   argv-only with the environment allowlist; paths validated against the narrowest root
   ([lesson](../lessons/2026-10-14-validate-paths-against-the-real-root.md)).
2. No secret, token or credential appears in a log line, error message, UI or persisted output.
   Captured output and log lines go through `redactSecrets`.
3. Error messages shown to the user are useful but do not expose stack traces, secrets or
   absolute paths outside the data directory ([SPEC-008 §5](2026-10-14-api-architecture.md#5-error-envelope)).
4. Secrets are never committed (`.env`, `*.db`, credentials) and never stored in plain text in
   the database ([ADR-0008](../decisions/0008-secret-storage-and-authentication.md)).
5. Mutating endpoints keep the local-mode protections: loopback binding, Host allowlist, Next.js
   server-action Origin check; future mutating route handlers check `Origin` and require JSON
   ([SPEC-008 §6](2026-10-14-api-architecture.md#6-request-protection-in-local-mode)).
6. Dependency hygiene: `pnpm audit --prod` runs in CI; dependencies follow the
   [SPEC-004 §4](2026-10-14-technology-stack.md#4-dependency-policy) policy — do not add a
   dependency for what a few lines of local code or a Node built-in cover.
7. A fix for a security-relevant bug ships with a regression test that fails without the fix.

## 6. Code quality

1. TypeScript strict; no `any`, no `@ts-ignore`; narrow `unknown` at runtime (Zod or type
   guards). Casts through `unknown` need a comment saying why they are safe.
2. Comments explain a non-obvious *why*, not *what*. Public functions with non-obvious contracts
   get a short doc comment.
3. Handle error and empty paths early with returns instead of nesting.
4. No silently swallowed errors. A `catch` handles, converts to a result, logs or rethrows. When
   an error is deliberately ignored (`catch {}`, `.catch(() => null)`), a comment states why —
   unless the expression's purpose is obviously "absent → fallback" (e.g. `stat(path).catch(() =>
   null)` used as an existence check).
5. No magic numbers or strings for timeouts, intervals, limits and sizes: name the constant (with
   a unit suffix) and, where the value is not obvious, say why it was chosen.
6. Boolean parameters: a new function whose call sites would pass a literal `true`/`false` takes a
   named option (`{ executionApproved }`) or is split into two functions.
7. Console output only in `apps/cli` and scripts. Packages report through return values, errors
   or an injected logger (`RunnerLogger`); the web app renders errors in the UI (enforced, §9).
8. No dead code, commented-out code or debug output in a change.
9. A change's diff traces to its stated purpose: no drive-by renames, reformatting or
   speculative options mixed into a behavioural change (`AGENTS.md` rule 10).

## 7. Error handling

- Packages throw named error classes for expected failures callers may handle (`ConfigError`,
  `UnsafeFileError`, `NotFoundError`, …) and plain `Error` only for invariants that indicate a
  bug.
- Library code never formats user-facing output or exits the process; the CLI maps errors to
  messages and exit codes (`CliError`).
- Server actions and `/api` route handlers follow [SPEC-008](2026-10-14-api-architecture.md):
  typed `{ ok, data } | { ok: false, error }` results for actions (target), the §5 error
  envelope for `/api`. Do not introduce a second envelope shape.

## 8. Web UI conventions

- **Reads** happen in React Server Components through repository functions. Client components do
  not call `fetch()` against the app's own routes; there are no internal HTTP hops.
- **Mutations** use server actions in `apps/web/lib/actions.ts`, validated with Zod (§3.4).
- **Component placement** — check these locations before writing a new component:
  1. Styling primitives (Button, Badge, Card, Table, …) → `components/ui/primitives.tsx`. They are
     shadcn-style but maintained by hand; there is no shadcn CLI or `components.json`.
  2. App-wide components (`PageHeader`, status badges, `MockBadge`, `NotSandboxedBadge`,
     `EmptyState`, `NotInitialized`, `PlannedSection`) → `components/common.tsx`, or a new
     kebab-case file in `components/` when a component is large or client-only.
  3. A component used by one page stays in that page's file or folder until a second page needs it.
- **States**: empty lists use `EmptyState`; an uninitialised data directory uses `NotInitialized`;
  unimplemented features use `PlannedSection`. A new shared component (for errors, tables) is
  introduced when it replaces real duplication, in a change of its own.

## 9. Enforcement

| Rule | Mechanism |
| --- | --- |
| Package dependency direction (§3.1); domain packages free of Next.js/React | ESLint `no-restricted-imports` per package in `eslint.config.mjs` |
| Web app: no runner, no engine orchestrator, agent adapters for detection only, no Drizzle / `node:sqlite` / `child_process` (§3.2–3.3) | ESLint `no-restricted-imports` for `apps/web` (Playwright tests in `apps/web/e2e/` are exempt because they seed the database) |
| No `any` (§6.1) | ESLint `@typescript-eslint/no-explicit-any` |
| Console only in the CLI and scripts (§6.7) | ESLint `no-console` for `packages/*/src` and `apps/web` |
| Formatting | Prettier (`pnpm format:check` in CI) |
| Dependency audit (§5.6) | `pnpm audit --prod` in CI |
| Everything else | Code review against §10 |

## 10. Code review checklist

**Structure**

- [ ] Naming follows §2; new files sit where §3 and §8 say they belong.
- [ ] No import crosses a package boundary (lint passes) and no package reaches into another
      package's internals instead of its exports.
- [ ] Input from outside the process is parsed with a shared Zod schema and only the parsed
      output is used (§3.4–3.5).
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (plus the extra gates in `AGENTS.md` §2).

**Security** (blockers unless marked)

- [ ] No untrusted input reaches a query, command or path unparameterised or uncanonicalised.
- [ ] No secret, token or credential in logs, errors, UI or persisted output.
- [ ] Safety checks (Host allowlist, execution approval, path containment) fail closed.
- [ ] Check-then-act on shared state is a single conditional statement or a transaction (§3.7).
- [ ] Imported repositories and benchmark scripts are not executed automatically.
- [ ] A security-relevant fix has a regression test. *(major)*

**Correctness and tests**

- [ ] A behaviour change ships with a test that fails on the old code; a bug fix with a
      regression test reproducing the bug.
- [ ] Concurrency-sensitive code (job acquisition, cancellation, shutdown) is tested for the
      concurrent or interrupted case, not only the happy path.
- [ ] Tests need no paid API, credentials or network; they use the mock agent and temp dirs.
- [ ] Mock results and unimplemented features are labelled honestly.

## 11. Known deviations in existing code

Found while adopting these standards on 2026-10-15. They are follow-ups, not blockers; fix each
in a focused change.

- **Unnamed literals (§6.5):** `timeoutMs + 5000` in `benchmark-engine/src/orchestrator.ts`;
  `timeout: 5000, maxBuffer: 64 * 1024` in `agent-adapters/src/detection.ts`;
  `PRAGMA busy_timeout = 5000` in `database/src/client.ts`; `AbortSignal.timeout(2000)` and the
  300 ms poll in `apps/cli/src/serve.ts`; the job list limit `100` in `apps/web/app/executions/page.tsx`.
  Runner timing defaults (`pollIntervalMs`, `heartbeatIntervalMs`, `staleAfterMs`,
  `shutdownTimeoutMs`) are named options but not exported constants.
- **Boolean argument (§6.6):** `result(assertion, false, message, details)` in
  `benchmark-engine/src/assertions.ts` (internal helper).
- **Uncommented casts (§6.1):** the two `as unknown as` casts in `database/src/client.ts` do not
  say why they are safe (`setReturnArrays(true)` makes rows arrays).

Checked and conforming: every ignored error is either commented or an obvious "absent →
fallback" (§6.4); there is no `any`, `@ts-ignore` or `eslint-disable` in source; the
check-then-write in `enqueueBenchmarkJob` reads only immutable versions and
`requestJobCancellation` uses status-guarded updates (§3.7).
- **Error handling (§7):** server actions throw plain `Error` and report blockers through a
  redirect query parameter instead of a typed result (already recorded in SPEC-008's
  implementation status); there is no `error.tsx`, and error text is rendered ad hoc as
  `<p className="text-destructive">` on three pages.
- **Validation (§3.4):** artifact frontmatter is parsed by hand (`core/src/frontmatter.ts`) and
  CLI flags are validated manually (`apps/cli/src/setup.ts`), not with Zod.

## Implementation status

- **Implemented (verified 2026-10-15):** ESLint enforcement of §9 — package dependency direction,
  web-app import restrictions and `no-console` outside the CLI. `pnpm lint` passes on the
  current code; temporary probe files importing forbidden modules (`@directivebench/runner`,
  the engine root and an unknown engine subpath, `drizzle-orm`, `node:sqlite`,
  `node:child_process` and a non-detection export of `@directivebench/agent-adapters` from
  `apps/web`; `database`/`runner`/`react` from `benchmark-engine`; `database`, `next/server` and
  `@directivebench/core-extra` from `core`; `console.log` in `core`) each produced the expected
  lint error, while the allowed subpaths `./definition`, `./load`, `./scoring` did not.
- **Not automated:** every other rule is enforced by review (§10).
- **Open:** the deviations listed in §11.

## Appendix A — Rules not adopted from the external document

| External rule | Why it was not adopted |
| --- | --- |
| `packages/{app,core,db,ui}` layout, `app → core → db`, `ui` imported by `app` only | DirectiveBench has a different package set and dependency graph ([ADR-0003](../decisions/0003-monorepo-architecture.md), SPEC-003). |
| Per-concept sub-folders (`entities/<concept>/`, `services/<concept>/`, `validators/<concept>/`) and the scaffold-a-concept procedure | Packages here are split by responsibility (parsing, persistence, adapters, engine, runner), not by domain concept; the domain is small enough that flat modules per package stay readable. |
| MikroORM entities (`defineEntity`, `*.entity.ts`), `em.create()` rules, `Knex.raw` | Persistence uses Drizzle over `node:sqlite` ([ADR-0002](../decisions/0002-sqlite-with-node-sqlite.md)). The intent — no raw SQL with input, no mass assignment — is kept in §3.5 and §5.1. |
| `awilix` DI container, `container.ts`/`cradle.ts`, service classes with a `Service` suffix | Dependencies are passed explicitly as function arguments and options; a container would add a dependency and indirection with no benefit (SPEC-004 §4). The "explicit wiring" intent is kept in §3.8. |
| Typed in-process event bus, `concept.entity.action` event IDs | The engine reports progress through callbacks (`onAgentRun`) and the runner persists state to SQLite; there is no in-process event bus to name (SPEC-003 §5). |
| Payment gateway port, Stripe adapter, money recomputation | No payments in this product. The port/adapter intent maps to `AgentAdapter` and model providers (§3.6). |
| `core/src/http/` (`AppError` hierarchy, `apiHandler`, `makeCrudRoute`, `auth.ts`) | There is one read-only route (`/api/health`) and two server actions; a CRUD route builder would be speculative. Error shapes are owned by SPEC-008; errors stay as package-local classes (§7). Revisit when `/api/v1` is implemented. |
| `{ ok: true, data } / { ok: false, error: { code, message, fieldErrors } }` as the HTTP envelope | Conflicts with the SPEC-008 §5 envelope (`{ error: { code, message, details, requestId } }`). Server actions already target `{ ok, data } \| { ok: false, error }` per SPEC-008. |
| `ui/src/backend/` with `apiCall`, `CrudForm`, `DataTable`, feedback components | Pages are server components that read repositories directly; no client code calls `fetch`. There are no create/edit forms yet. `EmptyState`/`NotInitialized` already cover shared states (§8). |
| shadcn primitives added only via `npx shadcn add` | Primitives are hand-maintained in one file without a shadcn configuration; adopting the CLI would be a separate decision. |
| Persona route groups (`(student)`, `(mentor)`, …) | Single-user local tool; no personas. |
| bcrypt/argon2 password hashing, JWT, auth cookies, CSRF header, login rate limiting, generic login errors, ownership checks | No authentication in local mode (SPEC-008 §6). Authentication for self-hosting is owned by [ADR-0008](../decisions/0008-secret-storage-and-authentication.md) and [SPEC-011](2026-10-14-self-hosting-architecture.md); these rules are a reasonable checklist when that work starts, not before. |
| UUID IDs | IDs are prefixed random IDs from `createId` (SPEC-006), which equally prevent enumeration. |
| `export const dynamic = "force-dynamic"` and "build without a database" | Already covered by SPEC-008 (pages render dynamically) and the `NotInitialized` state. |
| `pino` logger with redaction config | Logging is a small injected `RunnerLogger` with `redactSecrets` (SPEC-007 §3.1); no logging dependency is needed. |
| `npm run …` / `npm audit` commands | The repository uses pnpm; the equivalents are in `AGENTS.md` §6 and CI already runs `pnpm audit --prod`. |
| Changes to a `docs/product-scope.md` and the DevMentor `AGENTS.md` sections | Those files belong to the other product. |
