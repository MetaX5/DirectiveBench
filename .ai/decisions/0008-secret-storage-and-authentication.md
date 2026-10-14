# ADR-0008: Secret storage and authentication modes

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** Project maintainers (bootstrap proposal — pending maintainer review)
- **Related:** [Security and privacy](../specs/2026-10-14-security-and-privacy.md),
  [Settings and configuration](../specs/2026-10-14-settings-and-configuration.md),
  [Claude Code](../specs/2026-10-14-integration-claude-code.md),
  [Anthropic API](../specs/2026-10-14-integration-anthropic-api.md),
  [OpenAI API](../specs/2026-10-14-integration-openai-api.md),
  [ADR-0006](0006-agent-adapters-vs-model-providers.md), [ADR-0009](0009-self-hosted-readiness.md)

## Context

To run real agents and model providers DirectiveBench needs access to credentials. Two situations
exist:

- The user already has an official agent CLI (`claude`, `codex`, `cursor-agent`) installed and logged
  in, often with a subscription rather than an API key.
- The user wants to call a model provider API directly (Anthropic, OpenAI, DeepSeek, Z.AI, Moonshot,
  custom compatible endpoints) using an API key.

The bootstrap stores no secrets and implements no real agent execution or provider. This ADR fixes the
direction before any credential code is written.

## Decision

Two authentication modes, chosen per agent/provider configuration
([ADR-0006](0006-agent-adapters-vs-model-providers.md)):

**Local Subscription Mode**

- DirectiveBench invokes the **already-authenticated official CLI** as a subprocess and lets the CLI
  use its own login.
- DirectiveBench **never reads, copies, exports or stores** the CLI's credentials or tokens, and never
  proxies them to other tools.
- Availability is determined by detection (binary + version) and, where the CLI offers it, a
  non-destructive status check. Assumption — requires validation per CLI.

**API Key Mode**

- Keys are stored in the **OS credential store** (macOS Keychain, Windows Credential Manager,
  Linux Secret Service) through a keychain library. **Library choice is pending validation**
  (requirements: maintained, no fragile native build for `npx` users or a reliable prebuild story,
  works on all three OSes, headless Linux behaviour understood).
- **Environment variables** are the documented fallback (e.g. for CI or headless Linux without a
  secret service). The UI shows which source a key comes from.
- **No plaintext secrets by default**: never in SQLite, `config.json`, logs or exported files. The
  database stores only a reference (provider id + credential name). A plaintext file store, if ever
  added, must be explicit opt-in with a warning.
- **Redaction:** known secret values and common key patterns are redacted from command output,
  agent traces, logs and error messages before persistence or display (`@directivebench/core`
  provides redaction).
- Secrets are passed to subprocesses only via the environment of that subprocess, never via argv.

## Alternatives considered

- **Copy CLI credentials into DirectiveBench** (to reuse subscriptions in containers or remote
  runners). Rejected: violates the vendors' trust model, creates a second copy of high-value tokens,
  and may breach terms of service.
- **Encrypted file/SQLite storage with a master password.** Adds key management UX and is weaker
  than OS stores on desktops; may be reconsidered for headless servers.
- **Environment variables only.** Simple and transparent, but awkward for a UI-driven tool and
  easy to leak into child processes.
- **Plaintext in `config.json`.** Rejected.

## Benefits

- Subscription users can benchmark without creating API keys.
- Secrets stay in OS-protected storage; the data directory can be backed up or shared without
  leaking keys.
- Clear rules for code reviewers: no secret persistence outside the credential store.

## Drawbacks

- Keychain libraries vary in maintenance and may involve native code, conflicting with the no-native
  goal ([ADR-0004](0004-native-cli-distribution.md)); validation is required.
- Headless Linux often lacks a Secret Service, forcing the env-var fallback.
- Local Subscription Mode cannot be used in Docker or remote runners without the CLI being logged in
  inside that environment.

## Consequences

- Real agent execution and providers must not ship before this ADR is Accepted and a library is
  chosen.
- Runner contracts must assume credentials are resolved inside the trusted execution environment and
  never transmitted to a server ([ADR-0009](0009-self-hosted-readiness.md)).
- Redaction utilities live in `core` from bootstrap and must be applied to all persisted output.

## Status

Proposed. Not implemented. To be Accepted once a keychain library is validated on macOS, Windows and
Linux (desktop and headless) and the integration specs confirm each CLI's login/status behaviour.
