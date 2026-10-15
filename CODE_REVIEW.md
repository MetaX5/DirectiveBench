# Code review rules

How changes to DirectiveBench are reviewed, by a human or by `om-code-review` /
`om-auto-review-pr` (which apply this file automatically). It adds the review priorities and
severity mapping for this repository; it does not repeat the rules themselves.

**Read together with:**

- [SPEC-014 §10 — code review checklist](.ai/specs/2026-10-15-engineering-standards.md#10-code-review-checklist),
  configured as `reviewChecklist` in `.ai/agentic.config.json`. Apply every item; its Security
  items are blockers unless marked otherwise.
- [`AGENTS.md`](AGENTS.md) — the required workflow (specs, run logs, lessons, quality gate).
- [`BACKWARD_COMPATIBILITY.md`](BACKWARD_COMPATIBILITY.md) — protected surfaces.

## 1. Review priorities

Review in this order and stop treating a lower priority as important while a higher one is open.

1. **Safety of untrusted input.** DirectiveBench imports repositories and benchmark scripts it
   does not control (SPEC-007). Nothing imported is executed automatically; commands stay
   argv-only with the environment allowlist; paths are canonicalised against the narrowest root
   ([lesson](.ai/lessons/2026-10-14-validate-paths-against-the-real-root.md)); TLS verification
   is never disabled; secrets go through `redactSecrets` and never reach logs, errors, UI or the
   database.
2. **Local-first and local-mode protections.** Nothing may require a cloud service, account or
   hosted database. Loopback binding, the Host allowlist (`DIRECTIVEBENCH_ALLOWED_HOSTS`) and the
   server-action Origin check stay intact; safety checks fail closed.
3. **Correctness under concurrency.** The runner and the web app share one SQLite database.
   Check-then-act on job or snapshot state is a single conditional statement or
   `withTransaction`; job acquisition, cancellation, stale recovery and shutdown are tested for
   the interrupted or concurrent case.
4. **Contracts.** Every touched surface in `BACKWARD_COMPATIBILITY.md` follows its documented
   path (CLI flags and exit codes, `config.json`, benchmark definition v1, migrations, `/api`).
5. **Architecture.** The dependency direction in `AGENTS.md` §5 holds (ESLint enforces most of
   it); the web app never runs processes or benchmarks and imports agent adapters for detection
   only; persistence only through `@directivebench/database` repositories; external input is
   parsed with a shared Zod schema and only the parsed output is used.
6. **Process conformance.** See §3.
7. **Code quality.** SPEC-014 §6–§8: no `any`, named limits with unit suffixes, no literal
   boolean arguments in new APIs, console output only in `apps/cli` and scripts, component
   placement in `apps/web`.

## 2. Evidence the reviewer expects

| The diff touches… | Evidence in the PR |
| --- | --- |
| Any code | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` green; Vitest coverage thresholds (`vitest.shared.ts`) still met |
| `apps/cli`, `apps/web`, packaging or dependencies | `pnpm build` and `pnpm verify:pack` green |
| `apps/web` UI | `pnpm test:e2e` green; screenshots for visible changes |
| A bug fix | A regression test that fails without the fix |
| `packages/database/src/schema.ts` | A new migration generated with `pnpm db:generate`, committed and reviewed (§4 of `BACKWARD_COMPATIBILITY.md`) |
| Benchmark execution or results | A run against the deterministic mock agent (`directivebench demo` or tests); mock results labelled as mock |
| Any test | No paid API calls, credentials or network; temp directories, injected clocks and IDs |

## 3. Process checks (this repository's `.ai/` workflow)

- A significant change (feature, integration, data model, security, CLI or public interface)
  has a spec created or updated in `.ai/specs/` — no other spec directories. Missing spec for
  such a change: **major**.
- A change that contradicts an `approved` spec without changing the spec (and adding an ADR for
  a significant design change) in the same PR: **blocker**.
- A spec's **Implementation status** claims only verified behaviour; a spec moves to
  `implemented/` only when every acceptance criterion is verified; no agent sets `approved`.
  Overclaimed status: **major**.
- An autonomous run commits its run log in `.ai/runs/` with real verification results; a
  non-obvious bug fix or human correction adds a lesson. Missing: **minor**.
- Incomplete features are visibly marked as planned; mock results and `local-process` runs are
  labelled honestly ("Mock", "Not sandboxed"). Dishonest labelling: **major**.
- No `*.db`, `.env`, credentials or personal data committed: **blocker**.
- Diff stays on its stated purpose (no drive-by renames or reformatting): **minor**.

## 4. Severity mapping

`om-code-review`'s scale, anchored to this codebase:

| Severity | Examples here |
| --- | --- |
| **blocker** | Imported content executed automatically; shell string instead of argv; path not checked against its root; secret in output; safety check that fails open; a released migration edited; a breaking change to a protected surface without its path; failing validation gate |
| **major** | Race on job/snapshot state; missing regression test for a bug fix; dependency-direction or web-app restriction bypassed; raw `FormData`/YAML spread into a repository call; a new dependency against the SPEC-004 policy; missing spec for a significant change; mock results not labelled |
| **minor** | Unnamed timeout/limit; literal boolean argument in a new API; uncommented `as unknown as` cast; swallowed error without a reason; misplaced component; missing run log or lesson |
| **nit** | Wording, naming polish, optional simplification |

## 5. Known deviations

SPEC-014 §11 lists deviations that already exist on `main`. Do not raise them on an unrelated
PR; do raise them when the PR touches the affected code or adds a new instance.
