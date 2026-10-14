# ADR-0006: Agent adapters are separate from model providers

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Domain model](../specs/2026-10-14-domain-model.md),
  [Claude Code](../specs/2026-10-14-integration-claude-code.md),
  [OpenAI Codex](../specs/2026-10-14-integration-openai-codex.md),
  [Cursor](../specs/2026-10-14-integration-cursor.md),
  [Custom model providers](../specs/2026-10-14-integration-custom-model-providers.md),
  [ADR-0005](0005-custom-benchmark-engine.md), [ADR-0008](0008-secret-storage-and-authentication.md)

## Context

Users want to benchmark artifacts across "agents" and "models", but these words mix several
independent concerns:

- Claude Code can be used with a subscription login or an API key; whether and how it can be pointed
  at other compatible endpoints is an assumption that requires validation.
- Codex and Cursor Agent each have their own model selection and login methods (details per tool in
  the integration specs).
- A future custom coding harness could call any OpenAI- or Anthropic-compatible endpoint
  (Anthropic, OpenAI, DeepSeek, Z.AI GLM, Moonshot Kimi, self-hosted).
- The same harness/model pair may run in a local process today and in Docker or a remote runner later.

Modelling "agent = model" would make results incomparable and produce invalid configurations
(e.g. a harness asked to use a model it cannot reach).

## Decision

Model five separate concepts:

| Concept | Meaning | Examples |
| --- | --- | --- |
| **Agent harness** (agent adapter) | The program that reads instructions, edits files, runs tools | Claude Code, Codex, Cursor Agent, Mock Agent |
| **Model provider** | An API endpoint family serving models | Anthropic, OpenAI, DeepSeek, Z.AI, Moonshot, custom compatible |
| **Model** | A specific model ID at a provider | provider-specific IDs |
| **Auth method** | How access is obtained | local subscription login of the official CLI, API key |
| **Execution environment** | Where the harness runs | `local-process` (not sandboxed), `docker` (planned), remote runner (future) |

- `AgentAdapter` (in `packages/agent-adapters`) is a **capability-based** contract: detection
  (binary on PATH + `--version`), artifact install convention, supported auth methods, model
  selection support, and execution. Adapters declare capabilities; callers do not assume them.
- Model providers are a separate contract (future `packages/model-providers`; not created yet, see
  [ADR-0003](0003-monorepo-architecture.md)).
- A benchmark's `execution` block names the adapter, an optional `{provider, model}` and the
  environment kind. **Compatibility is explicitly validated** before a job is enqueued/run: the
  adapter must support the requested provider/model, auth method and environment; otherwise the run
  is rejected with a clear error instead of silently falling back.
- Capabilities that are not verified against the real tool are marked "Assumption — requires
  validation" in specs and are not enabled in code.
- All five dimensions are recorded in run metadata and are part of the comparability key.

## Alternatives considered

- **Single "agent/model" entity** (e.g. "Claude Code + Sonnet"). Simple UI, but cannot express
  the same harness with different models or auth methods, and duplicates configuration.
- **Models only (direct API calls).** Measures prompt quality, not artifact effect inside a coding
  harness, which is the product's purpose ([ADR-0005](0005-custom-benchmark-engine.md)).
- **Adapters own their model lists implicitly.** Hides compatibility rules inside each adapter and
  makes cross-harness comparisons ambiguous.

## Benefits

- Results state exactly what was measured; incomparable configurations are never aggregated.
- New harnesses and providers can be added independently.
- Invalid combinations fail early and visibly.

## Drawbacks

- More configuration surface in UI and definition format.
- Each adapter's real capabilities must be researched and kept current as vendor CLIs change.

## Consequences

- Bootstrap implements only the Mock Agent and detection descriptors for `claude`, `codex`,
  `cursor-agent`; real execution and model providers are specified, not implemented.
- The UI shows harnesses, providers and environments as separate selections, with
  "Not sandboxed" labelling for `local-process`.

## Status

Accepted.
