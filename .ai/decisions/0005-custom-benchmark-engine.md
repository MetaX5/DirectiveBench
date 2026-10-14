# ADR-0005: Custom benchmark engine (Promptfoo as optional adapter)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Benchmark engine](../specs/features/benchmark-engine.md),
  [Benchmark definition format](../specs/features/benchmark-definition-format.md),
  [RED/GREEN evaluation](../specs/features/red-green-evaluation.md),
  [Benchmark scoring](../specs/features/benchmark-scoring.md),
  [Promptfoo (optional)](../specs/integrations/promptfoo-optional.md),
  [ADR-0006](0006-agent-adapters-vs-model-providers.md)

## Context

DirectiveBench answers one question: **does installing this artifact (skill, instruction file, rule)
make a coding agent produce better results on a real workspace?** That requires:

1. A versioned fixture workspace (content-addressed snapshot) copied fresh for every run.
2. Running a **coding-agent harness** (Claude Code, Codex, Cursor Agent, Mock Agent) inside that
   workspace, not just sending a prompt to a model API.
3. **RED/GREEN comparison:** the same case run without the artifact (baseline) and with the exact
   artifact version installed using the harness's own install convention (e.g.
   `.agents/skills/<slug>/`), with identical prompt, fixture hash, adapter version, model config and
   limits.
4. Hidden verification overlays copied in after the agent finishes, then assertions over the
   resulting files and commands (`command`, `file-exists`, `file-contains`, `changed-files`).
5. Repetitions, stability, comparability keys and verdicts (improved / regressed / unstable / …).
6. Persistence of immutable suite versions, artifact versions and results in the local database.

Promptfoo is a mature, popular open-source tool for prompt and model evaluation, red-teaming and
provider comparison.

## Decision

- Build a **custom benchmark engine** in `packages/benchmark-engine`, independent of the database
  and UI: pure inputs (definition, fixture snapshot, artifact version, adapter) → results + events.
- Own the **benchmark definition format v1** (YAML/JSON, Zod-validated) with workspace, fixture,
  verification overlay, setup commands, allowed changes, assertions and mock playbooks.
- Treat **Promptfoo as an optional future adapter**, not a core dependency: possible export of
  DirectiveBench cases to Promptfoo configs and/or import of Promptfoo results/assertions where the
  concepts map. Specified in [promptfoo-optional](../specs/integrations/promptfoo-optional.md); not
  implemented.

## Alternatives considered

- **Promptfoo as the core engine.** Rejected: its focus is prompt/model/provider evaluation and
  red-teaming. Agent-harness execution in a prepared workspace, installing an artifact using each
  harness's convention, RED/GREEN pairing with comparability guarantees, and content-addressed
  fixture versioning are not its primary model; we would be working around it rather than with it.
  Assumption — requires validation: Promptfoo's current agent/provider extensions may cover parts of
  this; the decision does not depend on them being absent.
- **Other eval frameworks** (OpenAI Evals, Inspect, SWE-bench harnesses). Model- or dataset-centric,
  typically Python-based, and not oriented around per-artifact baseline/candidate comparisons inside
  a Node CLI.
- **Plain test runner (Vitest/`node --test`) with scripts.** Good for assertions, but no notion of
  variants, repetitions, scoring, comparability or persistence. The engine uses real commands such as
  `node --test` inside `command` assertions instead.

## Benefits

- The data model matches the product (artifact versions, fixture hashes, harness adapters).
- No heavy dependency in the npm package; full control over execution safety rules
  ([ADR-0007](0007-local-runner-execution-and-isolation.md)).
- The engine is testable in isolation with the deterministic Mock Agent.

## Drawbacks

- We maintain assertion types, scoring and reporting ourselves; features Promptfoo already has
  (LLM-as-judge, many providers, web viewer) must be built or bridged.
- A custom format means no existing ecosystem of shared test suites.

## Consequences

- Scoring and verdict rules are specified in [benchmark-scoring](../specs/features/benchmark-scoring.md)
  and are the engine's responsibility.
- Any Promptfoo integration lives in a separate adapter module and must not leak into the engine's
  core types.
- Planned assertion types (json-schema, static-analysis, custom script, llm-judge) are added to the
  engine; llm-judge must record judge model, rubric and prompt version because it is
  nondeterministic.

## Status

Accepted. Revisit if Promptfoo (or another tool) gains first-class workspace/agent-harness evaluation
that could replace the engine core.
