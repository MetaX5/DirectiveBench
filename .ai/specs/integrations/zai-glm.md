---
id: SPEC-209
title: Z.AI GLM model provider (z.ai international and bigmodel.cn)
status: draft
created: 2026-10-14
updated: 2026-10-14
category: integration
related: [SPEC-007, SPEC-110, SPEC-111, SPEC-115, SPEC-203, SPEC-206, SPEC-207, SPEC-211, ADR-0006, ADR-0008]
---

# SPEC-209 — Z.AI GLM (z.ai and bigmodel.cn)

> All "Confirmed" statements were checked against the cited official documentation on 2026-10-14.
> Source keys ([Z1] …) are listed in §14. Model ids are a snapshot. The shared model is in
> [SPEC-211](./custom-model-providers.md).

## 1. Purpose

This spec covers the `zai` provider type: GLM models from Z.AI. There are two officially documented
platforms:

- **International**: `z.ai` / `api.z.ai`.
- **Mainland China**: Zhipu's open platform, `bigmodel.cn` / `open.bigmodel.cn`.

Z.AI offers two commercial products with **different endpoints and usage terms**:

1. the general pay-as-you-go API, and
2. the **GLM Coding Plan** subscription.

Only the general API is a candidate for direct use by DirectiveBench's future custom coding harness
([SPEC-110 §19](../features/benchmark-execution.md#19-future-extensions)). The Coding Plan is
documented for use inside supported coding tools such as Claude Code. That path is an agent-harness
configuration under [SPEC-203](./claude-code.md) (§5.2).

## 2. Official integration options

| Option | Base URL | Evidence |
|---|---|---|
| General API, OpenAI-compatible Chat Completions (`POST /chat/completions`), OpenAI SDKs supported | `https://api.z.ai/api/paas/v4` | Confirmed ([Z1], [Z2], 2026-10-14) |
| Coding Plan, Anthropic Messages | `https://api.z.ai/api/anthropic` | Confirmed ([Z3], 2026-10-14) |
| Coding Plan, OpenAI Chat Completions ("coding endpoint") | `https://api.z.ai/api/coding/paas/v4` | Confirmed ([Z3], 2026-10-14) |
| Coding Plan, OpenAI Responses | `https://api.z.ai/api/v1` | Confirmed ([Z3], 2026-10-14) |
| bigmodel.cn, OpenAI-compatible | `https://open.bigmodel.cn/api/paas/v4/` | Confirmed ([Z4], 2026-10-14) |
| bigmodel.cn, Anthropic-compatible | `https://open.bigmodel.cn/api/anthropic` | Confirmed ([Z5], [Z6], 2026-10-14) |
| Z.AI's own SDKs (`zai-sdk` for Python and Java) | Not used (no TypeScript SDK documented) | Confirmed to exist ([Z1]) |
| List-models endpoint | **Not found** in the documentation index ([Z7]) | Not documented. See §5.1. |

Whether the `api.z.ai/api/anthropic` endpoint also serves **general (pay-as-you-go)** API keys, or
only Coding Plan keys, is not stated. Assumption — requires validation. Until validated, the `zai`
profile offers `anthropic-messages` only together with the Coding Plan restrictions in §10.

## 3. Authentication methods

- API key sent as `Authorization: Bearer <key>`. Keys are created on the Z.AI API Keys page. No other
  method (for example JWT) is documented on the reference introduction: Confirmed ([Z2], 2026-10-14).
  Examples also send `Accept-Language: en-US,en` ([Z2]). This is optional and treated as a non-secret
  header.
- **Coding Plan keys** are created under the plan's management pages. The Team Plan key "is not
  interchangeable with other Z.AI's API Keys": Confirmed ([Z3], 2026-10-14). The profile stores the
  key kind (`general` | `coding-plan`) as non-secret metadata, so endpoint and key mismatches can be
  reported clearly.
- bigmodel.cn keys come from the Zhipu open platform ([Z4]). Whether z.ai and bigmodel.cn keys are
  interchangeable is not documented. Assumption: they are **not**. Separate connections are required.
- Storage per [ADR-0008](../../decisions/0008-secret-storage-and-authentication.md).

## 4. Capability requirements

Facts from the Chat Completions reference ([Z8], 2026-10-14) and capability guides:

| Capability | GLM via general API | Evidence |
|---|---|---|
| Function calling | Yes. `tool_choice` **only supports `auto`**. | Confirmed ([Z9]) |
| Streaming | Yes (SSE, ends with `data: [DONE]`). Function-call streaming via `tool_stream: true` on GLM-4.6 and later series. | Confirmed ([Z8]) |
| Structured output | JSON mode `response_format: {"type":"json_object"}`. JSON-schema mode is not documented. | Confirmed ([Z10]) |
| Thinking | `thinking: {type: enabled\|disabled}`. GLM-5.3 / GLM-5.3-Flash "can only be enabled". `reasoning_effort` defaults to `max`, and only `low`/`high`/`max` are supported on GLM-5.3 models. Other values are mapped on GLM-5.2. | Confirmed ([Z8]) |
| Cross-turn reasoning | `thinking.clear_thinking` defaults to `true`, which **drops prior-turn `reasoning_content`**. `false` preserves it if forwarded unmodified. | Confirmed ([Z8]) |
| Max output | `max_tokens` up to 131,072 (128K) for the GLM-4.6 … GLM-5.3 series | Confirmed ([Z8]) |
| Context window | Not stated in the reviewed pages. Assumption — requires validation (vendor-docs table or user). | — |
| Usage | `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `total_tokens` | Confirmed ([Z8]) |
| Sampling | `temperature` in [0.0, 1.0] (default 1.0 for current series); `top_p` in [0.01, 1.0] (default 0.95); `do_sample: false` disables both | Confirmed ([Z8]) |

Model ids observed in the docs: `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx` ([Z8]), and older
`glm-5`, `glm-4.7`, `glm-4.6` ([Z10]). DirectiveBench does not ship this list as configuration. Users
enter model ids, and capability metadata comes from a dated vendor-docs table.

## 5. Architecture

Vendor profile `zai` with a `platform` setting (`international` | `china`) that selects the default
base URLs, and the codecs from [SPEC-211 §5](./custom-model-providers.md#5-architecture).

### 5.1 Validation without a list-models endpoint

No models endpoint is documented ([Z7]), so `validation.method = 'none'`. The connection shows
"credential not verified" until the user runs the explicitly labelled billable "Send test request".
That request is one minimal chat completion with `max_tokens` = 1 and `thinking` disabled where the
model allows it. Whether the Tokenizer API ([Z7]) could serve as a cheap credential check, and whether
it is billed: Assumption — requires validation.

### 5.2 GLM with Claude Code (vendor-documented, vendor-unsupported combination)

Z.AI documents ([Z5], 2026-10-14) Claude Code settings in `~/.claude/settings.json` `env`:
`ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`,
`API_TIMEOUT_MS=3000000`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` (for example
`glm-5.3-flash[1m]`, `glm-5.3[1m]`), `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The page notes compatibility was verified with Claude
Code 2.0.14. bigmodel.cn documents the same variables with `https://open.bigmodel.cn/api/anthropic`
([Z6]). The vendor's own page is inconsistent about default model mappings ([Z5], [Z6]).

Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" ([C2]).
DirectiveBench may expose this only through the experimental, vendor-unsupported gateway mode of
[SPEC-203](./claude-code.md). DirectiveBench injects variables into the agent subprocess environment
only. It never writes the user's `~/.claude/settings.json`. If that file already sets `env` values, it
may take precedence over the subprocess environment. This is documented by Moonshot for Claude Code
([K5] in [SPEC-210](./kimi.md)) and is an Assumption — requires validation in SPEC-203.

## 6. Relevant API or CLI interfaces

| Interface | Notes | Evidence |
|---|---|---|
| `POST https://api.z.ai/api/paas/v4/chat/completions` | `model`, `messages`, `tools`, `tool_choice` (`auto`), `stream`, `tool_stream`, `thinking`, `reasoning_effort`, `max_tokens`, `temperature`, `top_p`, `do_sample`, `response_format` | Confirmed ([Z2], [Z8]) |
| Response `finish_reason` ∈ `stop`, `tool_calls`, `length`, `sensitive`, `model_context_window_exceeded`, `network_error` | `sensitive` → run warning `content-filtered`. `model_context_window_exceeded` → `invalid-request` (context). `network_error` → `server-error`. | Confirmed ([Z8]) |
| Error body `{code, message}` with business codes (§9) | Mapped by business code first, then by HTTP status | Confirmed ([Z11]) |
| `POST https://open.bigmodel.cn/api/paas/v4/chat/completions` | Same shape assumed for bigmodel.cn. Parity of parameters between platforms: Assumption — requires validation. | Base URL confirmed ([Z4]) |

## 7. Configuration

| Field | Default |
|---|---|
| `providerType` | `zai` |
| `platform` | `international` (alternative `china`) |
| `keyKind` | `general` (alternative `coding-plan`, which only allows the SPEC-203 gateway use, see §10) |
| `protocol` | `openai-chat-completions` |
| `baseUrl` | `https://api.z.ai/api/paas/v4` / `https://open.bigmodel.cn/api/paas/v4` |
| `auth` | `bearer`, `secretRef` (keychain, or env such as `ZAI_API_KEY`, the name used in bigmodel.cn docs [Z4]) |
| `validation.method` | `none` (§5.1) |

## 8. Security concerns

All controls in [SPEC-211 §8](./custom-model-providers.md#8-security-concerns) apply.

- The data destination differs by platform (international vs mainland China). The UI shows the exact
  host and platform before the first run. The legal and compliance assessment is the user's.
- Content moderation: the API can reject or stop on sensitive content (business code 1301, finish
  reason `sensitive`) ([Z8], [Z11]). Benchmarks about security topics may trigger it. Such runs are
  flagged, not silently scored.

## 9. Error handling

Z.AI returns an HTTP status and a business `code` ([Z11], Confirmed 2026-10-14). Mapping:

| Business code (HTTP) | Meaning | Mapping |
|---|---|---|
| 1000, 1001, 1003, 1005 (401) | Authentication failed / missing / expired / 2FA required | `auth-invalid` |
| 1113 (429) | Insufficient balance or no resource package | `billing`, no retry |
| 1210–1215 (400) | Invalid or missing parameter | `invalid-request` |
| 1211 (400) | Unknown model | `model-not-found` |
| 1220 (403) | No permission for API | `auth-invalid` |
| 1261 (400) | Prompt too long | `invalid-request` (context) |
| 1301 (400) | Unsafe or sensitive content detected | `invalid-request` with a `content-filtered` warning |
| 1302 (429) | Rate limit reached | `rate-limited` |
| 1305 (429) | Service temporarily overloaded | `overloaded` |
| 1308, 1310, 1316–1321 (429) | Usage limit for a period (5 h / 7 d / weekly / monthly) reached, reset time in message | `billing`, no retry (reset time shown) |
| 1309, 1311, 1314, 1315 (429) | Coding Plan expired, model not in plan, enterprise package expired, key limited to the enterprise coding package | `billing`, no retry, with a key/plan hint |
| 1313 (429) | Fair Usage Policy limited | `billing`, no retry |
| 500, 1200, 1230, 1234 | Internal / API call / network error | `server-error` |

Many 429 codes are **not** transient rate limits. The business code decides retry behaviour, never
the HTTP status alone. Rate-limit values and headers: the rate-limit page could not be retrieved as
documentation on 2026-10-14 (it renders as a console page). Assumption — requires validation.

## 10. Compatibility restrictions

- **Coding Plan usage restriction**: the plan "is strictly limited to use within officially supported
  tools and products": Confirmed ([Z3], 2026-10-14). DirectiveBench's own harness is not such a tool.
  The `zai` profile therefore **refuses** `keyKind: coding-plan` for direct harness use. Coding Plan
  credentials may only be used through an officially supported tool (Claude Code, per [Z5]) in
  SPEC-203's experimental gateway mode. Whether automated benchmarking via that tool complies with
  the plan's subscription terms: Assumption — requires a terms review before release.
- Behavioural differences from OpenAI: `tool_choice` auto only; temperature range [0, 1] rather than
  OpenAI's range; prior-turn reasoning dropped by default (`clear_thinking`); thinking cannot be
  disabled on GLM-5.3 models; effort values remapped on GLM-5.2 ([Z8], [Z9]). Benchmarks record the
  declared settings, and the codec sends only values documented for the selected model.
- The international and China platforms are separate provider connections and separate
  comparability-key values, even for the same model id.

## 11. Test strategy

- Recorded fixtures: a chat completion with tool calls; streaming with `tool_stream`; usage with
  `cached_tokens`; each `finish_reason` value; a representative business code from every row of §9
  (to verify that "429 = retry" is never applied blindly).
- Codec tests: `tool_choice` other than `auto` is never sent; `reasoning_effort` values are limited
  per model; `clear_thinking` is explicit and recorded.
- Policy test: a `coding-plan` key is rejected for harness connections, with a clear message.
- Opt-in live test (`DIRECTIVEBENCH_LIVE_TESTS=1` and `ZAI_API_KEY`): one minimal chat completion.
  It is billable, so it runs only in the manual workflow with a cost cap.

## 12. Acceptance criteria

- [ ] AC-1: A `zai` connection can be created for either platform. The UI shows that the credential
  is unverified until a test request is explicitly sent.
- [ ] AC-2: Business codes 1113, 1308–1321 are classified as non-retryable `billing`. 1302 is retried
  within the cap.
- [ ] AC-3: A Coding Plan key cannot be attached to a harness (direct API) connection.
- [ ] AC-4: Runs record platform, base-URL host, model, thinking settings and `clear_thinking`.
- [ ] AC-5: Runs that end with finish reason `sensitive` or code 1301 are flagged as
  `content-filtered`.

## 13. Current implementation status

- **Implemented in bootstrap:** nothing.
- **Partially implemented:** none.
- **Not implemented:** the vendor profile, codecs, validation, secret storage, the harness, the
  Claude Code gateway mode, and the Model Providers UI (placeholder only).

## 14. Sources

[Z1]: https://docs.z.ai/guides/overview/quick-start
[Z2]: https://docs.z.ai/api-reference/introduction
[Z3]: https://docs.z.ai/devpack/quick-start
[Z4]: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
[Z5]: https://docs.z.ai/devpack/tool/claude
[Z6]: https://docs.bigmodel.cn/cn/coding-plan/tool/claude
[Z7]: https://docs.z.ai/llms.txt
[Z8]: https://docs.z.ai/api-reference/llm/chat-completion
[Z9]: https://docs.z.ai/guides/capabilities/function-calling
[Z10]: https://docs.z.ai/guides/capabilities/struct-output
[Z11]: https://docs.z.ai/api-reference/api-code
[C2]: https://code.claude.com/docs/en/llm-gateway

- [Z1] Z.AI quick start — https://docs.z.ai/guides/overview/quick-start
- [Z2] Z.AI API reference introduction — https://docs.z.ai/api-reference/introduction
- [Z3] GLM Coding Plan quick start / endpoint guide — https://docs.z.ai/devpack/quick-start
- [Z4] bigmodel.cn OpenAI compatibility — https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
- [Z5] Z.AI: Claude Code with GLM Coding Plan — https://docs.z.ai/devpack/tool/claude
- [Z6] bigmodel.cn: Claude Code with Coding Plan — https://docs.bigmodel.cn/cn/coding-plan/tool/claude (Anthropic base URL also in https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)
- [Z7] Z.AI documentation index — https://docs.z.ai/llms.txt
- [Z8] Chat completion reference — https://docs.z.ai/api-reference/llm/chat-completion
- [Z9] Function calling — https://docs.z.ai/guides/capabilities/function-calling
- [Z10] Structured output — https://docs.z.ai/guides/capabilities/struct-output
- [Z11] Errors — https://docs.z.ai/api-reference/api-code
- [C2] Claude Code, other LLM gateways — https://code.claude.com/docs/en/llm-gateway
