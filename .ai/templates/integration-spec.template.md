---
id: SPEC-2NN
title: Integration title
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
category: integration
related: [SPEC-NNN, ADR-NNNN]
---

# SPEC-2NN — Integration title

<!--
Copy this file to .ai/specs/YYYY-MM-DD-integration-<slug>.md (today's date) take the next free ID (SPEC-201…299),
and add the spec to .ai/specs/README.md.

Confirmed vs Assumption:
- Mark every statement about the external product as either
  "Confirmed (source, date)" — verified against official documentation or by running the tool, or
  "Assumption — requires validation" — believed but not verified.
- Never invent API endpoints, CLI flags, auth methods, models or limits.
- Re-verify confirmed items before implementation; external products change.
-->

## 1. Purpose

<!-- What this integration enables in DirectiveBench and which feature specs use it. -->

## 2. Official integration options

<!-- The officially supported ways to integrate (REST API, SDK, CLI, MCP…), each marked Confirmed / Assumption. -->

## 3. Authentication methods

<!-- Supported auth (API key, OAuth, subscription login, tokens), where credentials live, and what DirectiveBench must never store or upload. -->

## 4. Capability requirements

<!-- Which adapter/provider capabilities DirectiveBench needs and which this integration offers. Mark gaps. -->

## 5. Architecture

<!-- Where the integration code lives (package), how it plugs into adapters/providers/runner. Diagram if useful. -->

## 6. Relevant API or CLI interfaces

<!-- The specific endpoints, commands or flags used, each marked Confirmed / Assumption with source. -->

## 7. Configuration

<!-- Settings the user provides, defaults, validation, and storage location (secrets per ADR-0008). -->

## 8. Security concerns

<!-- Credential handling, command execution, data leaving the machine, rate-limit abuse, log redaction. -->

## 9. Error handling

<!-- Auth failures, rate limits, timeouts, missing binaries, version mismatches — and how each is reported. -->

## 10. Compatibility restrictions

<!-- Supported versions, OSes, plans/tiers, regional availability, terms-of-service constraints. -->

## 11. Test strategy

<!-- Contract tests with recorded fixtures by default; opt-in live tests only (never in CI by default). -->

## 12. Acceptance criteria

<!-- Observable, verifiable conditions. -->

- [ ] AC-1: …

## 13. Current implementation status

<!-- Precise and conservative: Implemented / Partially implemented / Not implemented. -->

- **Implemented:** …
- **Partially implemented:** …
- **Not implemented:** …
