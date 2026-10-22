# Benchmark my own skill with a real agent: Claude Code runs against registry artifacts, including version-vs-version (S1)

- Date: 2026-10-22
- Category: feature
- Priority signal: high — the maintainer reports that after 0.1.1-rc.0 the app has no use beyond preview; benchmarking is its main job
- Risk signal: high — first real-agent execution (process control, auth modes, ambient-config leakage, subscription terms), new comparability dimensions
- Routing: Next: om-auto-write-spec "Benchmark own skills with Claude Code against registry artifacts, baseline = no skill or another version (S1) — brief: .ai/specs/briefs/2026-10-22-benchmark-own-skills-s1.md"

## Problem

The maintainer constantly revises skills and instructions in internal tools and client projects. Each revision is
tested on a different prompt or task, so results are not comparable and "did this change help?" has no reliable
answer. Version-against-version (A/B) checks are not done at all today. Reference case: a project-estimation skill
that must produce realistic hours; it was revised several times and the output is still unsatisfactory. The maintainer
judges such output by a combination of numbers within expected ranges (an item known to take X hours estimated at
4·X is obviously wrong), consistent document structure, and presence of required information (QA, PM/communication).
The skill's output is a Markdown file with prose and tables; its inputs are client briefs, PRDs, Figma exports and
call transcripts.

Evidence it matters: the D07 value checkpoint (#30) has an early answer. After using 0.1.1-rc.0 on 2026-10-22 the
maintainer said the preview is nice but the product's main job is benchmarking skills and building one's own
benchmarks, and that currently there is no other usefulness. Today the engine runs only the deterministic mock agent,
suites are imported YAML bound to bundled example artifacts, and scanned registry artifacts cannot be benchmarked.

## Agreed direction

**Decision D08 (to record in `product-brief.md`):** switch from the Registry (D01) to the comparison work now; the
rest of E02/E03 waits. The work is generic — users build their own scenarios, requirements and grading; the
estimation skill is only the reference scenario, not a target to special-case.

One epic, three slices; this brief covers **S1** only:

- **S1 (this brief):**
  - Claude Code execution adapter per SPEC-203, using the user's installed `claude` CLI headless.
  - Run a suite against a **scanned registry artifact version** from the CLI
    (`directivebench benchmark run <suite> --artifact <id>`).
  - Baseline = **no artifact** or **another version of the same artifact** (A/B); candidate = the chosen version.
  - `directivebench benchmark init --artifact <id>` scaffolds a suite folder (YAML + fixture folder) the user edits
    and imports.
  - Generic document-oriented assertions in addition to the existing ones: required Markdown sections/headings,
    required phrases/regex in an output file, and a numeric value in a Markdown table row (row matched by pattern,
    column by header) within a range.
  - Results stored per artifact version; the web UI shows results and history per artifact (read-only).
- **S2 (later brief):** builder UI to create and edit scenarios (fixture files, prompt, requirements) and choose
  grading from the assertion catalogue; "Run" from the UI.
- **S3 (later brief):** sets/chains of skills (D02); LLM-judge rubric grading.

Rejected alternatives:

- **Build nothing** (keep manual testing; a YAML file plus a shell loop over `claude -p` and a diff script would take
  about a weekend). Rejected because it gives no history per skill version, no comparability guarantees and no
  catalogue binding — the things the maintainer named as the product's value.
- **Promptfoo as the executor / check Promptfoo first (A04, #26).** Consciously skipped; recorded in D08 with the
  reason: DirectiveBench binds benchmarks to skills scanned from repositories, keeps results per skill version, will
  offer a builder UI (also for non-developers) and runs as one local tool without provider configuration. A04 stays
  untested.
- **Builder first.** Rejected: a builder on the mock agent produces no real result; the agent and run path come first.
- **No-skill vs skill only (A/B deferred to S3).** Rejected: for a skill being revised the real question is "is v(n)
  better than v(n-1)?".

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| First agent | Claude Code (local CLI, headless). Codex and Cursor later. |
| Auth and isolation | Both modes. Local Subscription Mode is the default: it needs the real `HOME`, so `~/.claude` config leaks in (SPEC-203 §3.2, §7); runs carry warning `ambient-user-config`, the label "may include user-level instructions", and are never compared across machines. API Key Mode isolates `HOME`/`CLAUDE_CONFIG_DIR` and is the "clean" mode. The mode and isolation profile are part of the comparability key. |
| Baseline | No artifact, or another version of the same registry artifact (A/B) — both in S1. |
| Surfaces in S1 | CLI for init and run; web UI read-only for results and per-version history. Running from the UI arrives with the builder (S2). |
| Where suites live | Suite folders on disk (versionable in git), imported into the database as immutable suite versions, as the engine already does. |
| Grading in S1 | Deterministic assertions only: existing `command`, `file-contains`, `changed-files`, plus required Markdown sections/headings, required phrases/regex, and table-cell numeric range. |
| Non-determinism | Conditions are deterministic (same fixture, prompt, assertions); agent variance is handled by `repetitions` and the existing stability scoring. |
| Fixture inputs | Files only (briefs, PRDs, transcripts, Figma exports as PDF/PNG). No live MCP sources. |
| Promptfoo (A04) | Consciously skipped; reason recorded in D08 (see Agreed direction). |

Open assumptions to carry into the spec (not blocking):

- What executes the reference skill inside the maintainer's internal tool is unknown; a result under Claude Code may
  not transfer to that harness (risk to D03).
- Repetitions × versions × fixtures consume subscription quota or API spend; the cost is not sized yet. The UI and CLI
  must state that runs count against the user's plan.
- Whether automated runs on a subscription are within the subscription terms is still the open review in SPEC-203
  §3.2.
- D03 still has no metric or stop condition (Q05).
- Suggested cheap check, in parallel and not blocking: 2 real briefs, `claude -p` 3× each on estimation-skill v(n-1)
  and v(n), scored by a throwaway script; compare with the maintainer's own judgement.

## Non-goals

- Builder UI and running from the UI (S2).
- LLM-judge / rubric grading, sets and chains of skills (S3).
- Codex and Cursor adapters, Agent SDK option, gateways and model providers.
- Docker environment (`environment.kind: docker`).
- Live Figma/MCP inputs in fixtures.
- Categories (#22) and the rest of E02 (#20, #21).

## Affected areas (if known)

- `packages/agent-adapters` — new Claude Code adapter (SPEC-203; today `createExecutableAdapters()` contains only `mock`).
- `packages/benchmark-engine` — new assertion types; baseline variant sourced from an artifact version.
- `packages/database`, `packages/runner` — runs bound to registry artifact versions (`artifact_benchmark_assignments` exists).
- `apps/cli` — `benchmark init` and `benchmark run --artifact`.
- `apps/web` — read-only results and history per artifact version.
- Specs to update rather than duplicate: SPEC-203, SPEC-107, SPEC-110, SPEC-111, SPEC-112, SPEC-113; roadmap M3/M4.
