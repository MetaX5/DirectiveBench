---
id: SPEC-208
title: DeepSeek API model provider
status: draft
created: 2026-10-14
updated: 2026-10-14
category: integration
related: [SPEC-007, SPEC-110, SPEC-111, SPEC-115, SPEC-203, SPEC-206, SPEC-207, SPEC-211, ADR-0006, ADR-0008]
---

# SPEC-208 — DeepSeek API

> All "Confirmed" statements were checked against the cited official documentation on 2026-10-14.
> Source keys ([D1] …) are listed in §14. DeepSeek renames and retires models often. Model names
> below are a snapshot, not configuration. The shared model is in [SPEC-211](./custom-model-providers.md).

## 1. Purpose

This spec covers the `deepseek` provider type: DeepSeek models through DeepSeek's own API, used by the
future custom coding harness ([SPEC-110 §19](../features/benchmark-execution.md#19-future-extensions)).
It also records what DeepSeek officially documents about using its Anthropic-compatible endpoint
with Claude Code. That combination is an agent-harness configuration governed by
[SPEC-203](./claude-code.md), not by this spec.

## 2. Official integration options

| Option | Base URL | Evidence |
|---|---|---|
| OpenAI-format Chat Completions `POST /chat/completions` | `https://api.deepseek.com` | Confirmed ([D1], [D2], 2026-10-14) |
| OpenAI-format Responses `POST /responses` (stateless) | `https://api.deepseek.com` | Confirmed ([D3], 2026-10-14) |
| Anthropic-format Messages | `https://api.deepseek.com/anthropic` | Confirmed ([D1], [D4], 2026-10-14) |
| List models `GET /models` | `https://api.deepseek.com` | Confirmed ([D5], 2026-10-14) |
| Claude Code via `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` | Officially documented by DeepSeek ([D6], 2026-10-14). See §5.2. |
| Beta features (chat prefix completion, FIM) | — | Exist ([D7]). Not used. |

DirectiveBench default protocol: `openai-chat-completions`, because it is the most fully documented
DeepSeek surface. `openai-responses` and `anthropic-messages` are selectable per connection.

## 3. Authentication methods

- API key from the DeepSeek platform, sent as `Authorization: Bearer <key>` in the docs' examples
  (`DEEPSEEK_API_KEY`): Confirmed ([D1], 2026-10-14).
- Anthropic endpoint: `x-api-key` is listed as supported: Confirmed ([D4], 2026-10-14). Whether
  `Authorization: Bearer` is also accepted there is an Assumption — requires validation, although
  DeepSeek's Claude Code guide passes the key via `ANTHROPIC_AUTH_TOKEN`, which Claude Code sends as
  `Authorization: Bearer` ([D6], [C1]).
- Storage per [ADR-0008](../../decisions/0008-secret-storage-and-authentication.md). No other auth
  mechanism is documented.

## 4. Capability requirements

Snapshot of the model table ([D7], 2026-10-14):

| Model id | Version served | Context | Thinking | JSON output | Tool calls | Responses API | Anthropic API |
|---|---|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | Both (thinking is the default) | Yes | Yes | Yes | Yes |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | Both (thinking is the default) | Yes | Yes | Yes | Yes |

- Max output: the table shows a single "384K" value spanning both rows. Per-model applicability is an
  Assumption — requires validation. Chat Completions `max_tokens` accepts 1–393,216, with defaults
  of 8K (non-thinking), 64K (thinking) and 128K (thinking at `max` effort): Confirmed ([D2]).
- Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired, and their
  requests are served by DeepSeek-V4.1-Flash: Confirmed ([D1], [D7]).
- `GET /models` returns per model `context_window`, `max_output_tokens`, input/output modalities,
  `effort.supported_levels` / `default_level`, and
  `api_capabilities.anthropic_messages.system_prompt_update`: Confirmed ([D5]). The profile uses
  these as `source: 'provider-api'`. Tool-calling support is taken from the docs table
  (`source: 'vendor-docs'`).
- Structured output: Chat Completions offers JSON mode (`response_format: {type: "json_object"}`,
  and the prompt must also ask for JSON) ([D2]). Responses offers `text.format` `json_object` /
  `json_schema` ([D3]). Strictness of `json_schema` enforcement: Assumption — requires validation.
- Usage (Chat Completions): `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`,
  `completion_tokens_details.reasoning_tokens`. With streaming, usage arrives in the last chunk only
  when `stream_options.include_usage` is set: Confirmed ([D2]). The codec always sets it.

## 5. Architecture

Vendor profile `deepseek` with three protocol options
([SPEC-211 §5](./custom-model-providers.md#5-architecture)). Each connection uses one of them.

### 5.1 Protocol-specific rules

- **Chat Completions**: `thinking: {type: enabled|disabled}` and `reasoning_effort`
  (`none`/`low`/`high`/`max`) are recorded in run metadata. `tool_choice` `required` or a named
  function is not supported in thinking mode ([D2]), so the codec sends `auto` and sets
  `forcedToolChoice = 'no'` when thinking is on.
- **Responses**: "The API is **stateless**", so full history is sent each turn. Built-in tool types
  are ignored. File inputs are not supported. `developer` is treated as `user`. Effort aliases are
  remapped (`minimal`→`low`, `medium`/`xhigh`→`high`): Confirmed ([D3]). The codec sends only
  documented values, so no silent remapping happens.
- **Anthropic Messages**: see §10. Silent model-name mapping makes this protocol unsuitable for
  benchmarks unless the exact DeepSeek model id is sent.
- **Keep-alive while waiting**: non-streaming responses may contain empty lines, and streams may
  contain `: keep-alive` SSE comments. The server closes the connection if inference has not started
  within 10 minutes: Confirmed ([D8]). The parser must skip both kinds of keep-alive, and the timeout
  maps to `timeout`/`network`.

### 5.2 DeepSeek with Claude Code (vendor-documented, vendor-unsupported combination)

DeepSeek documents these Claude Code settings ([D6], 2026-10-14): `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
`ANTHROPIC_AUTH_TOKEN=<DeepSeek key>`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`,
`CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, with
model values such as `deepseek-flash[1m]`. Anthropic states it "doesn't support routing Claude Code to
non-Claude models through any gateway" ([C2]). DirectiveBench may only offer this as the
"experimental, vendor-unsupported" gateway mode defined in [SPEC-203](./claude-code.md). The
DeepSeek connection's secret is injected only into that subprocess's environment. Which Claude Code
features work against this endpoint: Assumption — requires validation per Claude Code version.

## 6. Relevant API or CLI interfaces

| Interface | Notes | Evidence |
|---|---|---|
| `POST https://api.deepseek.com/chat/completions` | `model`, `messages`, `thinking`, `reasoning_effort`, `response_format`, `tools`, `tool_choice`, `stream`, `stream_options.include_usage`, `max_tokens` | Confirmed ([D2]) |
| `POST https://api.deepseek.com/responses` | `input`, `instructions`, `reasoning.effort`, `max_output_tokens`, `stream`, `text.format`, `tools` (function only), `tool_choice` | Confirmed ([D3]) |
| `POST https://api.deepseek.com/anthropic/v1/messages` | Full path inferred from base URL + Anthropic SDK convention. Assumption — requires validation. | Base URL confirmed ([D4]) |
| `GET https://api.deepseek.com/models` | Validation and discovery (no tokens consumed) | Confirmed path ([D5]). The page did not show the base URL or auth; Bearer is assumed from [D1]. |

## 7. Configuration

| Field | Default |
|---|---|
| `providerType` | `deepseek` |
| `protocol` | `openai-chat-completions` (alternatives: `openai-responses`, `anthropic-messages`) |
| `baseUrl` | `https://api.deepseek.com` (`https://api.deepseek.com/anthropic` for `anthropic-messages`) |
| `auth` | `bearer` (`x-api-key` for `anthropic-messages`), `secretRef` (keychain, or env `DEEPSEEK_API_KEY`) |
| `validation.method` | `list-models` |

## 8. Security concerns

All controls in [SPEC-211 §8](./custom-model-providers.md#8-security-concerns) apply. Benchmark
prompts, artifacts and file contents are sent to DeepSeek. The UI names the destination host before
the first run. Data-handling and regional terms are the user's decision; DirectiveBench links to the
provider's terms and makes no claims about them.

## 9. Error handling

| HTTP | DeepSeek meaning | Mapping | Evidence |
|---|---|---|---|
| 400 | Invalid format | `invalid-request` | Confirmed ([D9]) |
| 401 | Authentication fails | `auth-invalid` | Confirmed ([D9]) |
| 402 | Insufficient balance | `billing`, no retry | Confirmed ([D9]) |
| 422 | Invalid parameters | `invalid-request` | Confirmed ([D9]) |
| 429 | Rate limit reached (concurrency) | `rate-limited` | Confirmed ([D8], [D9]) |
| 500 | Server error | `server-error` | Confirmed ([D9]) |
| 503 | Server overloaded | `overloaded` | Confirmed ([D9]) |

Rate limits are **concurrency-based** and per account, regardless of API key: 2,500 concurrent
requests for `deepseek-flash` and 500 for `deepseek-v4-pro`. A request holds a slot until its
response completes: Confirmed ([D8], 2026-10-14). Rate-limit response headers are not documented
(Assumption: none). Backoff therefore relies on the SPEC-211 defaults.

## 10. Compatibility restrictions

- **Silent model mapping on the Anthropic endpoint**: `claude-opus*` → `deepseek-v4-pro`,
  `claude-haiku*`/`claude-sonnet*` → `deepseek-flash`, and **unsupported model names are
  automatically mapped to `deepseek-flash`**: Confirmed ([D4]). DirectiveBench sends only exact
  DeepSeek ids on this protocol, compares the response `model` with the request, and records an
  `uncontrolled-difference` warning on mismatch.
- Anthropic endpoint field support ([D4]): `anthropic-version` ignored; `anthropic-beta` ignored for
  `/messages`; `temperature` 0.0–2.0; `thinking` supported but `budget_tokens` ignored;
  `output_config` only `effort`; `top_p` only in thinking mode; `top_k`, `container`, `mcp_servers`,
  `service_tier` ignored; `cache_control` ignored; `disable_parallel_tool_use` ignored;
  `document`, `redacted_thinking`, MCP and code-execution blocks not supported; `is_error` on
  `tool_result` ignored.
- Sampling: `temperature` has no effect in thinking mode, and `top_p` is fixed at 1.0 in
  non-thinking mode ([D3], [D4]). Sampling settings in benchmark definitions may therefore be
  ineffective. They are recorded as declared, not as applied.
- Model names and the versions behind them change (retired names are re-routed). The `Model
  Version` from [D7] at run time cannot be read from the API. The profile records the documented
  mapping with its date, and results across remaps are not comparable.

## 11. Test strategy

- Recorded fixtures: `GET /models` with the extended fields; Chat Completions streaming with
  `: keep-alive` comments and a final usage chunk; a non-streaming response preceded by blank lines;
  a Responses function-call round trip; an Anthropic-endpoint response whose `model` differs from
  the request (mismatch warning); all §9 errors.
- Codec tests: `stream_options.include_usage` is always set; no forced `tool_choice` in thinking
  mode; only documented effort values are sent.
- Opt-in live test (`DIRECTIVEBENCH_LIVE_TESTS=1` and `DEEPSEEK_API_KEY`): list models, then one
  minimal chat completion. Structural assertions only. Never in default CI.

## 12. Acceptance criteria

- [ ] AC-1: A `deepseek` connection validates via `GET /models`. Discovered models show
  `context_window` and `max_output_tokens` from the API.
- [ ] AC-2: The SSE and non-streaming parsers tolerate the documented keep-alive lines.
- [ ] AC-3: On `anthropic-messages`, a response model differing from the requested model produces a
  visible warning on the run.
- [ ] AC-4: 402 is classified `billing` and not retried. 429 is retried within the cap.
- [ ] AC-5: The Claude Code + DeepSeek configuration is reachable only through the SPEC-203
  experimental gateway mode, and is labelled vendor-unsupported.

## 13. Current implementation status

- **Implemented in bootstrap:** nothing.
- **Partially implemented:** none.
- **Not implemented:** the vendor profile, codecs, validation, model discovery, secret storage, the
  harness, the Claude Code gateway mode, and the Model Providers UI (placeholder only).

## 14. Sources

[D1]: https://api-docs.deepseek.com/
[D2]: https://api-docs.deepseek.com/api/create-chat-completion
[D3]: https://api-docs.deepseek.com/api/create-response
[D4]: https://api-docs.deepseek.com/guides/anthropic_api
[D5]: https://api-docs.deepseek.com/api/list-models
[D6]: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
[D7]: https://api-docs.deepseek.com/quick_start/pricing
[D8]: https://api-docs.deepseek.com/quick_start/rate_limit
[D9]: https://api-docs.deepseek.com/quick_start/error_codes
[C1]: https://code.claude.com/docs/en/env-vars
[C2]: https://code.claude.com/docs/en/llm-gateway

- [D1] DeepSeek API docs, first call — https://api-docs.deepseek.com/
- [D2] Create chat completion — https://api-docs.deepseek.com/api/create-chat-completion
- [D3] Create response — https://api-docs.deepseek.com/api/create-response
- [D4] Anthropic API guide — https://api-docs.deepseek.com/guides/anthropic_api
- [D5] List models — https://api-docs.deepseek.com/api/list-models
- [D6] Integrate with Claude Code — https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
- [D7] Models and pricing — https://api-docs.deepseek.com/quick_start/pricing
- [D8] Rate limit — https://api-docs.deepseek.com/quick_start/rate_limit
- [D9] Error codes — https://api-docs.deepseek.com/quick_start/error_codes
- [C1] Claude Code environment variables — https://code.claude.com/docs/en/env-vars
- [C2] Claude Code, other LLM gateways — https://code.claude.com/docs/en/llm-gateway
