# AGENTS.md — instructions for AI coding agents

This file is the **canonical** instruction set for every AI agent working in this repository
(Claude Code, OpenAI Codex, Cursor, GitHub Copilot and others). Agent-specific files such as
`CLAUDE.md` only point here and summarise; if they ever disagree, this file wins.

DirectiveBench is a local-first, open-source workbench for discovering, organizing, testing and
benchmarking AI agent skills, instructions and rules. Start with
[`.ai/specs/README.md`](.ai/specs/README.md) and
[`.ai/specs/2026-10-14-project-overview.md`](.ai/specs/2026-10-14-project-overview.md).

## 1. The `.ai/` knowledge base (mandatory)

```text
.ai/
├── specs/                    # specifications for spec-driven development (SDD)
│   ├── README.md             # index, naming rules, lifecycle
│   ├── YYYY-MM-DD-slug.md    # active specs (draft / approved)
│   ├── product-brief.md      # product brief written by om-discover (fixed name)
│   ├── backlog.md            # backlog record written by om-backlog (fixed name)
│   ├── research/             # discovery material: interviews, decisions, templates
│   ├── implemented/          # specs whose acceptance criteria are verified
│   └── archive/              # deprecated or superseded specs
├── runs/                     # logs of autonomous AI runs: YYYY-MM-DD-slug.md
├── lessons.md                # index of durable lessons (long-term memory)
├── lessons/                  # one file per lesson: YYYY-MM-DD-slug.md
├── decisions/                # architecture decision records (ADRs): NNNN-slug.md
└── templates/                # templates for specs, proposals, run logs and lessons
```

- **Specs** say *what* the system must do. **ADRs** say *why* a decision was made.
  **Run logs** say *what an AI run did*. **Lessons** keep *what we learned*. Code is *how*.
- File names in `specs/`, `runs/` and `lessons/` **must** use `YYYY-MM-DD-slug.md`
  (date = creation date, `slug` = lowercase kebab-case). The exceptions are index files
  (`README.md`) and the fixed paths the `om-*` skills read and write in `specs/`:
  `product-brief.md`, `backlog.md` and the `research/` directory (its own naming is set by
  `om-discover`). Do not create other specification directories (no `docs/specs/`, `ai/specs/`,
  …).

## 2. Required workflow

These rules are not optional. A task is not done until the applicable steps are complete.

### Before you start

1. Read this file, [`.ai/specs/README.md`](.ai/specs/README.md) and [`.ai/lessons.md`](.ai/lessons.md).
2. Read the specs relevant to your task and the ADRs in [`.ai/decisions/`](.ai/decisions/README.md)
   that they reference.
3. **Plan complex tasks before editing code.** For anything multi-step or cross-package, use plan
   mode (or write the plan into the run log) and get the plan right so implementation can go in
   one pass. For large or risky plans, have a second agent review the plan as a sceptical staff
   engineer. If implementation drifts from the plan, stop and re-plan instead of pushing through.
4. For an **autonomous run** (multi-step work you plan and execute yourself), create
   `.ai/runs/<today>-<slug>.md` from
   [`.ai/templates/run-log.template.md`](.ai/templates/run-log.template.md) with
   `status: in-progress`.

### While working

5. **Spec first.** A significant change (new feature, new integration, data-model, security, CLI
   or public-interface change) needs a spec. Update the existing spec, or create a new draft as
   `.ai/specs/<today>-<slug>.md` from a template in [`.ai/templates/`](.ai/templates/) and add it
   to the index — before implementing it.
6. Follow existing architecture and conventions. Do not contradict an `approved` spec; if it
   must change, change the spec (and, for significant design changes, add an ADR) in the same
   change set.
7. **Every new feature must have 100% unit-test coverage** — lines, branches, functions and
   statements — and so must every change to existing code. `pnpm test` enforces a 100% threshold
   for all logic (`packages/*/src`, `apps/cli/src`, `apps/web/lib`, `apps/web/proxy.ts`); a
   change below 100% fails CI and is not done. React pages and components (`apps/web/app`,
   `apps/web/components`) are outside the unit-coverage scope; every new page or UI path needs a
   Playwright test in `apps/web/e2e` instead. Never lower thresholds, widen exclusions or add
   `/* v8 ignore */` to pass the gate; the only exception is code that cannot run on the CI
   platform (e.g. a Windows-only branch), marked `/* v8 ignore next -- <reason> */` and named in
   the PR description. Tests must not require paid API calls or credentials; use the
   deterministic mock agent.
8. **Fix bugs from evidence.** Start from the failing CI job, test output or logs, reproduce the
   failure first, fix the root cause rather than the symptom and add a regression test. Do not
   ask how to fix something you can investigate yourself.
9. Do not add dependencies without a clear need; prefer the platform and existing packages.
10. Keep changes focused: do not modify unrelated files.
11. Keep DirectiveBench local-first: nothing may require a cloud service, account or hosted
    database to run locally.
12. Never commit secrets, credentials, personal data or local databases (`*.db`, `.env`).

### Before you finish

13. Run the quality gate and fix failures:
    `pnpm lint && pnpm typecheck && pnpm test` — plus `pnpm build && pnpm verify:pack` when you
    touched `apps/cli`, `apps/web`, packaging or dependencies, and `pnpm test:e2e` and
    `pnpm test:storybook` for UI changes.
14. **Prove the change works and review it critically.** Exercise the changed behaviour for real
    (run the CLI, open the page, run `directivebench demo`) and review your own diff as a
    sceptical reviewer would; do not open a PR until it passes that review. If a fix works but is
    a hack, redo it cleanly now that you understand the problem.
    For a UI change in `apps/web`, also run an exploratory browser QA agent (Claude in Chrome
    or agent-browser) on the built app after `directivebench demo` (flows, invalid input,
    keyboard only, both themes, 320px, console) and the Codex adversarial review until it
    approves; each confirmed finding gets a regression test
    ([lesson](.ai/lessons/2026-10-28-ui-changes-get-a-browser-qa-agent.md)).
15. Update the spec's **Implementation status** only for behaviour you verified. Move a spec to
    `.ai/specs/implemented/` (status `implemented`) only when *all* acceptance criteria are
    verified; move deprecated specs to `.ai/specs/archive/`. Never mark interfaces, stubs or
    placeholder pages as implemented, and never set `approved` yourself.
16. Record lessons: when you fixed a non-obvious bug, hit a misleading error or learned a
    constraint, add `.ai/lessons/<today>-<slug>.md` (from
    [`.ai/templates/lesson.template.md`](.ai/templates/lesson.template.md)) and a one-line entry in
    [`.ai/lessons.md`](.ai/lessons.md). Update or delete lessons that turned out wrong.
    **Every correction from a human is a lesson:** record it so the mistake is not repeated, and
    if it is a rule for all future work, also add it to this file — never only to an
    agent-specific file such as `CLAUDE.md`.
17. Finalise the run log: real verification results, deviations, what was **not** verified,
    lessons recorded, follow-ups. Never claim unfinished or unverified work is complete.

## 3. Parallel work, subagents and skills

- Use subagents for independent research, reviews and parallelisable sub-tasks, so the main
  context stays focused on decisions and integration. Give each subagent a self-contained brief
  and the exact files it may change; parallel agents must never edit the same files.
- Run independent tasks in separate git worktrees or branches, one agent session per worktree.
- **Keep large or temporary data off `/tmp` and clean up after yourself (hard rule).** `/tmp` is
  often a RAM-backed `tmpfs`, and so is an agent scratchpad under it: put worktrees, clones,
  `node_modules`, builds, data directories and benchmark data on disk, with worktrees in
  `.ai/tmp/` (git-ignored). Every agent removes what it created (worktrees, temporary
  directories, data directories, servers it started) before it finishes, also after a failure,
  and a subagent brief says so. Tests and scripts that use `os.tmpdir()` remove their
  directories ([lesson](.ai/lessons/2026-10-30-keep-heavy-data-off-tmp.md)).
- Turn a workflow you repeat often into a skill committed to git
  (`.agents/skills/<name>/SKILL.md`, exposed to Claude Code through a symlink in
  `.claude/skills/`). Check the existing `om-*` skills before writing a new one.

## 4. Git and GitHub workflow

- Never commit directly to `main`. Create a branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
- Before adding commits to an existing branch, check its PR is still open
  (`gh pr view --json state,mergedAt`). Work for a merged or closed PR goes on a new branch from
  the current `main` with a new PR; never rewrite a merged PR's description.
- Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope where useful,
  e.g. `feat(benchmark-engine): …`, `fix(cli): …`, `docs(specs): …`. Make small, logical commits.
- Use the GitHub CLI (`gh`) for pull requests and issues: `gh pr create`, `gh pr view`,
  `gh issue create`. PR descriptions summarise the change, list verification commands with
  results, and link the specs, ADRs and run log involved.
- PR descriptions use the house layout of the existing PRs — `## Summary`, `## ⚠️ Decision needed`
  (when open), `## Verification` (a command/result table, red-first proof, real-app run, what was
  not verified), `## Review` (after review rounds), `## Links`, `## Follow-ups`,
  `## Decisions touched`, then `Closes #N` — even when an `om-*` skill supplies its own template
  (see [`.ai/lessons/2026-10-21-pr-bodies-follow-the-house-layout.md`](.ai/lessons/2026-10-21-pr-bodies-follow-the-house-layout.md)).
- Review PRs with `om-auto-review-pr <n>` (engine `om-code-review`), also when only asked
  whether a PR can be approved; never with a hand-briefed agent. Do not claim another author's
  PR while they are still pushing to it
  ([lesson](.ai/lessons/2026-10-22-review-prs-through-om-auto-review-pr.md)).
- Commit the run log, spec updates and lessons together with the code they describe.

## 5. Repository map

| Path | Purpose |
| --- | --- |
| `apps/cli` | `directivebench` npm package: commands, lifecycle, embedded runner, packaging |
| `apps/web` | Next.js App Router UI; reads SQLite, enqueues jobs, never executes benchmarks |
| `packages/core` | Domain types, artifact parsers, config, hashing, redaction |
| `packages/database` | Drizzle schema, migrations, `node:sqlite` client, repository functions |
| `packages/agent-adapters` | Agent adapter contract, deterministic mock agent, CLI detection |
| `packages/benchmark-engine` | Benchmark format, fixtures, assertions, scoring, RED/GREEN orchestration |
| `packages/runner` | SQLite-backed job runner and example import |
| `examples/` | Executable mock example and specification-only examples |
| `scripts/verify-pack.mjs` | Packs, installs and smoke-tests the CLI tarball |

Dependency direction: `core ← database`, `core ← agent-adapters ← benchmark-engine`,
`{core, database, agent-adapters, benchmark-engine} ← runner`, `apps/* ← packages/*`. No cycles.
ESLint (`pnpm lint`) enforces it, including the web app's restrictions (SPEC-003 §2.1).

## 6. Commands

```bash
pnpm install          # Node >= 22.16, pnpm via corepack or ~/.local/share/pnpm/bin
pnpm dev              # CLI in dev mode: migrations, runner and `next dev`
pnpm lint             # ESLint
pnpm typecheck        # tsc / next typegen for every package
pnpm test             # Vitest unit and integration tests, 100% coverage threshold
pnpm test:e2e         # Playwright smoke test (builds required)
pnpm test:storybook   # every Storybook story in both themes, with axe (Chromium required)
pnpm build            # build web app and CLI bundle
pnpm verify:pack      # pack, install and smoke-test the npm tarball
```

## 7. Conventions

- TypeScript strict mode; avoid `any`; validate external input with Zod at boundaries.
- Imported repositories and benchmark scripts are untrusted: never execute them automatically,
  never disable TLS verification, keep commands argv-only with an environment allowlist.
- The mock agent must always be labelled as a mock; never present mock results as AI results.
- Incomplete features must be visibly marked as planned or not implemented.
- App-authored UI copy must not use en dash (U+2013) or em dash (U+2014), including labels,
  notices, tooltips, accessible names and missing-value placeholders. Use a colon,
  parentheses, a separate sentence or a normal hyphen where appropriate. Preserve imported
  content, user data, raw agent output and benchmark evidence verbatim; do not apply a
  blanket replacement to rendered or stored data. Existing-copy cleanup and automated
  enforcement are tracked in [issue #123](https://github.com/MetaX5/DirectiveBench/issues/123).
- Verify all visible text contrast (at least 4.5:1 for normal-size text, 3:1 for large text)
  in both themes, including muted text, navigation, status badges, errors and placeholders
  on their actual backgrounds. Check enabled buttons in rest, hover and focus states;
  button-only checks do not establish contrast for the rest of the UI.
  Buttons need pointer cursors; inline form buttons
  must match adjacent input heights. A UI preset does not waive these checks.
- Before building or changing UI in `apps/web`, read
  [`apps/web/design-system.md`](apps/web/design-system.md) and the Storybook
  (`pnpm --filter @directivebench/web storybook`). Use its components, tokens and patterns;
  a new component or variant follows its "Contributing" page and gets stories and a page.
- Design generic capabilities. A user's concrete case (one skill, client or document type) is a
  reference scenario to check the design, never a target to special-case: users build their own
  scenarios, requirements and grading
  ([lesson](.ai/lessons/2026-10-22-design-generic-not-for-the-example.md)).
- Follow the engineering standards in
  [`.ai/specs/2026-10-15-engineering-standards.md`](.ai/specs/2026-10-15-engineering-standards.md)
  (SPEC-014): naming, architecture rules, security minimums, code quality and the review
  checklist. In short:
  - Persistence only through `@directivebench/database` repositories; the web app never runs
    processes or benchmarks. Use the Zod-parsed output, never raw `FormData` or request bodies.
  - Check-then-act on shared state is one conditional statement or a `withTransaction`.
  - Safety checks fail closed; untrusted input never reaches a query, command or path
    unparameterised or uncanonicalised; secrets never reach logs, errors or the UI.
  - No silently swallowed errors, no unnamed timeouts or limits, no literal `true`/`false`
    arguments in new APIs, console output only in `apps/cli` and scripts.
  - No speculative packages, abstractions or options; three similar lines beat a premature helper.

## 8. Other agents

- **Codex** and **Cursor** read `AGENTS.md` natively.
- **Claude Code** reads [`CLAUDE.md`](CLAUDE.md), which imports this file.
- **GitHub Copilot**: if needed, add `.github/copilot-instructions.md` containing only a pointer to
  this file — do not duplicate the rules.
- Any other tool: configure it to read `AGENTS.md`; do not create competing instruction files.
