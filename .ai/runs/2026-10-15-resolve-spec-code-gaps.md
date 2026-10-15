---
title: Resolve spec-versus-code gaps found during reconciliation
date: 2026-10-15
agent: Claude Code / claude-opus-5-5
trigger: Maintainer request — "fix the code or the specs depending on which is right"; also confirmed that the om-* skills are MIT-licensed
status: completed
branch: fix/resolve-spec-code-gaps
specs: [SPEC-004, SPEC-005, SPEC-007, SPEC-009, SPEC-107, SPEC-110, SPEC-111, SPEC-112, SPEC-114, SPEC-115]
---

# Run: Resolve spec-versus-code gaps

## Objective

The bootstrap reconciliation (run `2026-10-14-bootstrap-foundation`) recorded every place where
a specification and the implementation disagree as "Partially implemented". For each gap decide
whether the spec or the code is right, then fix the wrong side, with tests for code changes.

## Plan

Decision rule: when the spec describes safer, more correct or more informative behaviour that is
cheap to implement, change the code; when the code is the better design (or the spec only names
things differently), change the spec. Gaps caused only by missing features of later milestones
stay as documented.

Code changes (spec is right):

1. FR-114-02 — validate execution approval and environment **before** enqueueing (web action),
   using one shared engine helper also used by the orchestrator.
2. FR-110-08 — commands: SIGTERM to the process group, SIGKILL after a 5 s grace period.
3. FR-110-02 — verify the copied workspace manifest hash equals the fixture snapshot hash.
4. FR-114-13 — graceful shutdown waits at most 10 s, then marks remaining jobs `interrupted`.
5. FR-114-15 — runner lifecycle events as redacted JSON lines in `<dataDir>/logs/runner.log`
   plus stderr.
6. FR-114-17 — runner id `local-<hostname>-<pid>-<random>`.
7. FR-111-06 — full-precision scores with a `1e-9` epsilon for threshold comparisons.
8. FR-111-27 — a case without valid runs in either variant makes suite means null and the
   verdict `error`.
9. FR-111-42 / FR-112-14 — `nondeterministic` flag and "not conclusive" label for single
   nondeterministic repetitions.
10. FR-112-08 — post-run equivalence check over recorded per-run metadata (fixture hash per case,
    adapter version) with a mismatch list.
11. Verdict `reasons` in the scoring summary (spec §8) so the UI can explain verdicts.
12. Capability checks (`headless`, `artifactInstallation`) before a run starts.
13. `doctor`: data-directory writability and a remediation hint for every non-ok check.
14. SPEC-004 dependency policy — bundle pure-JS runtime dependencies (`commander`, `zod`,
    `yaml`, `drizzle-orm`) into `cli.js`; only `next`, `react`, `react-dom` stay runtime
    dependencies.
15. FR-115-50 — Settings page states "Planned — not implemented" and links to its spec.

Spec changes (code is right):

- SPEC-111/112 API sections: document the implemented functions (`scoreRun`, `aggregate`,
  `summarize`, `confidenceFor`, `displayStatus`, `assertRunnable`, `runBenchmark`,
  `comparabilityKey`) instead of `planRun`/`checkEquivalence`; `cases[].delta` instead of
  `perCaseDelta`.
- SPEC-111 FR-111-03: zero total weight is rejected by the definition schema.
- SPEC-005: environment metadata is recorded once per benchmark run (identical for all agent
  runs by construction).
- SPEC-107/003: stage-level progress events are planned; `onAgentRun` is the current contract.
- SPEC-004 §4.7: `pnpm audit` in CI only if it passes cleanly today; otherwise mark planned.

## Decisions

- All 15 planned code changes were implemented; none turned out to be wrong after closer reading.
- Spec-side changes were delegated to a subagent with an explicit list of facts and files; it was
  allowed to edit only `.ai/specs/` and ADR-0004.
- The om-* skills stay in the repository: the maintainer confirmed they are MIT-licensed.

## Work performed

Commits on `fix/resolve-spec-code-gaps` (new PR; first pushed by mistake to the already merged `feat/bootstrap-foundation`, see Problems):

- `feat(benchmark-engine)`: scoring precision/epsilon, FR-111-27, verdict reasons,
  nondeterministic/conclusive flags, `executionBlockers`, capability checks, workspace hash check,
  `equivalenceIssues`, SIGTERM → SIGKILL grace period; follow-up commit: `modelSelection`
  capability check (FR-107-07), stage trace events with timestamps (FR-110-15) and the
  `[truncated N bytes]` marker (FR-110-44), which the spec update had still listed as gaps.
- `feat(runner)`: 10 s shutdown cap with `interruptJobs`, `local-<hostname>-<pid>-<random>` ids,
  structured log events.
- `feat(cli)`: `runner.log` JSON lines, `doctor` writability and hints, bundled pure-JS deps with
  a `createRequire` banner, Vitest include restricted to `test/`.
- `feat(web)`: server-side enqueue validation with on-page errors, verdict reasons, Settings wording.
- `ci`: `pnpm audit --prod`; `build(cli)`: lockfile.
- `docs(specs)`: requirement texts, API sections and implementation-status updates.

## Verification

Local, Node 24.21.0, pnpm 12.11.2:

- `pnpm format:check`, `pnpm lint` — pass; `pnpm typecheck` — 7/7 pass.
- `pnpm test` — 95 tests pass (core 36, agent-adapters 8, database 7, benchmark-engine 31,
  runner 6, cli 7). New tests cover epsilon thresholds, FR-111-27, reasons, conclusiveness,
  execution blockers, equivalence mismatches, tampered fixture store, capability checks, SIGTERM
  grace and SIGKILL escalation, shutdown cap, runner id format, `doctor` hints and writability,
  model-selection capability, stage order and the truncation marker.
- `pnpm build && pnpm verify:pack` — pass; the packed tarball's runtime dependencies are only
  `next`, `react`, `react-dom`.
- `pnpm test:e2e` — 7/7 pass, including the server-side approval re-check and verdict reasons.
- `<dataDir>/logs/runner.log` inspected after the Playwright run: redacted JSON lines with
  `acquired` and `finished` events.
- `pnpm audit --prod` — no known vulnerabilities.

Not verified: cancellation of a running job from the UI (covered only at repository/runner
level), Windows process-group termination, Node 22.x.

## Problems and deviations

- Bundling CommonJS `yaml` into the ESM CLI bundle failed at runtime
  (`Dynamic require of "process" is not supported`); fixed with a `createRequire` banner and
  caught by the Playwright web-server start before `verify:pack`.
- After `pnpm build`, Vitest in `apps/cli` collected fixture tests from `dist/examples`; fixed
  with an explicit include.
- **Pushed to a merged PR.** PR #1 had been merged on 2026-10-14 22:08 before this run's
  commits were pushed to `feat/bootstrap-foundation`, so they were not in `main` and CI did not
  run; the merged PR's description was also edited to describe them. The maintainer pointed this
  out. The commits were rebased onto `origin/main` as `fix/resolve-spec-code-gaps` (clean, no
  content change) and opened as a new PR; PR #1's description was restored. Rule added to
  AGENTS.md §4 and recorded as a lesson.
- A first scripted edit of `scoring.ts` aborted on its own over-strict self-check; the file was
  rewritten in full instead (no partial change was written).

## Lessons recorded

- [Restrict Vitest's include when build output contains test files](../lessons/2026-10-15-vitest-collects-build-output.md)
- [Bundler defaults break the packed CLI](../lessons/2026-10-14-bundler-strips-node-protocol.md) (updated)
- [Check the PR is still open before pushing follow-up commits](../lessons/2026-10-15-check-pr-state-before-pushing.md)

## Follow-ups

- Playwright test for cancelling a running job from the Executions page.
- Gaps that remain by design are later-milestone features (repository sync, real agents, Docker,
  `/api/v1` error envelope, stage-level progress events, version-regression detection).
