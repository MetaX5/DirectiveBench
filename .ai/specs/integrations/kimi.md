---
id: SPEC-210
title: Moonshot AI Kimi model provider
status: draft
created: 2026-10-14
updated: 2026-10-14
category: integration
related: [SPEC-007, SPEC-110, SPEC-111, SPEC-115, SPEC-203, SPEC-206, SPEC-207, SPEC-211, ADR-0006, ADR-0008]
---

# SPEC-210 — Moonshot AI Kimi

> All "Confirmed" statements were checked against the cited official documentation on 2026-10-14.
> Moonshot's platform docs moved from `platform.moonshot.ai` (now a 301 redirect) to
> `platform.kimi.ai`. Source keys ([K1] …) are listed in §14. The shared model is in
> [SPEC-211](./custom-model-providers.md).

## 1. Purpose

This spec covers the `moonshot` provider type: Kimi models on the **Kimi API Open Platform**
(pay-as-you-go), used by the future custom coding harness
([SPEC-110 §19](../features/benchmark-execution.md#19-future-extensions)). It also records Moonshot's
official Claude Code configuration, which is an agent-harness concern under [SPEC-203](./claude-code.md).

The platform "uses pay-as-you-go billing with no subscription plan" and is different from Kimi
Membership and **Kimi Code**: Confirmed ([K1], 2026-10-14). Kimi Code (a separate subscription
product with its own endpoint, per third-party guides only) is **out of scope** and not verified.

## 2. Official integration options

| Option | Base URL / endpoint | Evidence |
|---|---|---|
| OpenAI Chat Completions | `https://api.moonshot.ai/v1` → `POST /chat/completions` | Confirmed ([K2], 2026-10-14) |
| OpenAI Responses | `https://api.moonshot.ai/v1` → `POST /responses` | Confirmed ([K2], 2026-10-14) |
| Anthropic Messages ("Official Anthropic SDKs, Claude Code, and similar tools") | `https://api.moonshot.ai/anthropic` → `POST /anthropic/v1/messages` | Confirmed ([K2], 2026-10-14) |
| List models | `GET https://api.moonshot.ai/v1/models` | Confirmed ([K3], 2026-10-14) |
| Estimate tokens, check balance | `POST /v1/tokenizers/estimate-token-count`, `GET /v1/users/me/balance` | Confirmed ([K2], 2026-10-14) |
| Request signature verification | `X-Msh-Request-Nonce` request header → `Msh-Request-Timestamp`, `Msh-Request-Signature` response headers; `POST /v1/signatures/verify` | Confirmed ([K4], 2026-10-14) |
| Files, Batch, web search/fetch tools | Exist ([K2]). Not used by the harness. | Confirmed |
| Claude Code via `ANTHROPIC_BASE_URL` | `https://api.moonshot.ai/anthropic` | Officially documented by Moonshot ([K5], 2026-10-14). See §5.2. |
| Codex, Kimi Code CLI, OpenCode and others | Documented by Moonshot ([K6]) | Out of scope here (harness specs) |

Default DirectiveBench protocol: `openai-chat-completions`. The parameter reference and most guides
target it ([K6]).

## 3. Authentication methods

- `Authorization: Bearer $MOONSHOT_API_KEY` for all requests. Keys are managed in the Kimi Open
  Platform console: Confirmed ([K2], 2026-10-14). The Anthropic endpoint accepts the key via the
  Anthropic SDK's `api_key` ([K2]); the exact header it reads is an Assumption — requires validation.
- **Platform key isolation**: "Keys issued on `platform.kimi.ai` are independent from keys issued on
  other regional Kimi platforms. Mixing keys across platforms returns 401": Confirmed ([K7],
  2026-10-14). The other regional platform's API base URL is **not** verified here. Users can add it
  as a separate `moonshot` connection with an explicit base URL (Assumption — requires validation).
- Organisations can enforce an **IP allowlist**. A disallowed IP gets 403 `permission_denied_error`
  ([K7]).
- Storage per [ADR-0008](../../decisions/0008-secret-storage-and-authentication.md).

## 4. Capability requirements

| Capability | Kimi | Evidence |
|---|---|---|
| Tool calling | Yes (`tools`, `tool_calls`, also in streaming) | Confirmed ([K6]) |
| `tool_choice` | `auto` (default), `none`, `required`, or a named function object | Confirmed ([K8]) |
| Structured output | `response_format` for JSON Mode or Structured Output (`json_schema` appears in the Messages API schema) | Confirmed ([K6], [K9]). Strictness: Assumption — requires validation. |
| Streaming | Yes (SSE), with final usage data | Confirmed ([K6]) |
| Thinking / reasoning | Thinking models with `reasoning_content`. `reasoning_effort` `low`/`high`/`max` for Kimi K3. On OpenAI-compatible endpoints `thinking` is a Kimi extension sent via `extra_body`. | Confirmed ([K2], [K6]) |
| Model metadata from API | `GET /v1/models` returns `context_length`, `supports_image_in`, `supports_video_in`, `supports_reasoning` | Confirmed ([K3]) |
| Context window | `kimi-k3` up to 1M tokens. `kimi-k2.7-code` and `kimi-k2.6` 256K. | Confirmed ([K6]) |
| Usage reporting | Provided (streaming guide mentions final usage). Exact field names: Assumption — requires validation from the chat reference. | Partially confirmed |

`toolCalling` is not a field of `GET /v1/models`. It is set from the docs (`source: 'vendor-docs'`).
`contextWindowTokens` and `reasoning` come from the API (`source: 'provider-api'`).

Model ids seen in the docs (snapshot): `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`,
`kimi-k2.6` ([K5], [K6]). They are not hardcoded. Discovery uses `GET /v1/models`.

## 5. Architecture

Vendor profile `moonshot` with the three codecs ([SPEC-211 §5](./custom-model-providers.md#5-architecture)).

### 5.1 Profile-specific rules

- Validation uses `GET /v1/models`, which needs a valid key and consumes no tokens ([K3]).
  `GET /v1/users/me/balance` is shown optionally, as remaining balance, and is never required.
- Chat Completions: `thinking` is sent as a top-level extension field only when the user configures
  it. It is recorded in run metadata. The "partial mode" assistant-prefill extension is not used.
- Messages: prompt caching is controlled only by a top-level `cache_control`. `cache_control` markers
  inside `messages` are ignored ([K9]). The codec does not emit inner markers.
- Long requests: a gateway returns 504 (HTML page) when the server sends nothing for 900 s, so
  streaming is mandatory in the profile ([K7]). The Main Concepts page also mentions a 2-hour request
  timeout ([K10]). Both limits are recorded; the stricter one governs.
- **Optional provenance check (future)**: when enabled, the codec sends a random UUID v4 as
  `X-Msh-Request-Nonce` and stores the returned timestamp and signature with the turn. A later
  verification call proves the Kimi API accepted that request for that model. It "does not prove
  that the request ultimately succeeded", and nonces are not recorded server-side ([K4]). This is
  useful for audits of published benchmark results. Not part of v1.

### 5.2 Kimi with Claude Code (vendor-documented, vendor-unsupported combination)

Moonshot documents ([K5], 2026-10-14) writing these keys into the `env` field of
`~/.claude/settings.json`: `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`,
`CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_EFFORT_LEVEL`, with
values such as `kimi-k3[1m]` and `kimi-k2.7-code`. Two notes from that page matter for DirectiveBench:

- "The `env` block in `settings.json` **overrides** same-named variables exported in your
  terminal." An adapter that injects variables into the subprocess environment can therefore be
  silently overridden by the user's settings file. [SPEC-203](./claude-code.md) must detect this or
  isolate the configuration. Precedence on the Claude Code side: Assumption — requires validation
  against Claude Code docs.
- `kimi-k2.7-code` has thinking forced on and requires thinking enabled in Claude Code ([K5]).

Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" ([C2]).
DirectiveBench exposes this only through SPEC-203's experimental, vendor-unsupported gateway mode,
and never writes `~/.claude/settings.json`.

## 6. Relevant API or CLI interfaces

| Interface | Use | Evidence |
|---|---|---|
| `POST https://api.moonshot.ai/v1/chat/completions` | Generation (default) | Confirmed ([K2]) |
| `POST https://api.moonshot.ai/v1/responses` | Generation (alternative) | Confirmed ([K2]) |
| `POST https://api.moonshot.ai/anthropic/v1/messages` | Generation (alternative) | Confirmed ([K2]) |
| `GET https://api.moonshot.ai/v1/models` | Validation and discovery | Confirmed ([K3]) |
| `POST https://api.moonshot.ai/v1/signatures/verify` | Future provenance check | Confirmed ([K4]) |
| Error body `{"error": {"type", "message"}}` | Mapped by `error.type` (§9) | Confirmed ([K2], [K7]) |

## 7. Configuration

| Field | Default |
|---|---|
| `providerType` | `moonshot` |
| `protocol` | `openai-chat-completions` (alternatives: `openai-responses`, `anthropic-messages`) |
| `baseUrl` | `https://api.moonshot.ai/v1` (`https://api.moonshot.ai/anthropic` for `anthropic-messages`) |
| `auth` | `bearer`, `secretRef` (keychain, or env `MOONSHOT_API_KEY`) |
| `validation.method` | `list-models` |
| `provenanceSignatures` | `false` (future) |

## 8. Security concerns

All controls in [SPEC-211 §8](./custom-model-providers.md#8-security-concerns) apply.

- Moonshot warns that keys must not be exposed "in client-side code, public repositories, or logs"
  ([K2]). Its Claude Code guide notes the settings file holds the key in plain text ([K5]).
  DirectiveBench never writes keys to that file.
- Prompts, artifacts and file contents go to `api.moonshot.ai`. The UI states the host before the
  first run. Zero-data-retention is an enterprise option ([K6]). DirectiveBench makes no retention
  claims.
- Content safety review can reject requests (`content_filter`, HTTP 400) ([K7]). Runs are flagged
  `content-filtered`.

## 9. Error handling

Confirmed ([K7], 2026-10-14):

| HTTP / `error.type` | Mapping |
|---|---|
| 400 `content_filter` | `invalid-request` with a `content-filtered` warning |
| 400 `invalid_request_error` (incl. input too long, prompt + `max_tokens` over the model limit) | `invalid-request` |
| 401 `invalid_authentication_error`, `incorrect_api_key_error` | `auth-invalid` (hint: key from a different regional platform) |
| 403 `permission_denied_error` (API not open, IP not allowlisted) | `auth-invalid` with the message shown |
| 404 `resource_not_found_error` | `model-not-found` |
| 429 `engine_overloaded_error` | `overloaded` (honour `Retry-After`; topping up does not help) |
| 429 `exceeded_current_quota_error` | `billing`, no retry |
| 429 `rate_limit_reached_error` (org concurrency / RPM / TPM / TPD) | `rate-limited`. TPD is not retried within the run (resets next day). |
| 499 `client_closed_request` | `network` (or `cancelled` when DirectiveBench aborted) |
| 500 `server_error` / `unexpected_output` | `server-error` |
| 503 `server_unavailable` | `overloaded` |
| 504 gateway timeout (HTML body) | `timeout`. The parser must accept a non-JSON body. |

## 10. Compatibility restrictions

- **Rate limits by tier** (organisation level), based on cumulative recharge. A minimum $1 recharge is
  required. Example: Tier0 allows concurrency 1, 3 RPM, 500,000 TPM, 1,500,000 TPD; Tier5 allows
  concurrency 100, 300 RPM: Confirmed ([K11], 2026-10-14). Low tiers can make repeated benchmarks
  slow. The UI surfaces 429 reasons rather than hiding them.
- Rate-limit headers (`X-RateLimit-Limit` / `-Remaining` / `-Reset`) are documented only for the
  web-search endpoints ([K11]). For chat endpoints: Assumption — none.
- Kimi extensions (`thinking` via `extra_body`, partial mode) mean that requests built for OpenAI do
  not exercise the same behaviour ([K2]).
- Moonshot publishes recommended benchmarking settings (for example `temperature = 1.0`,
  `top_p = 0.95`, `stream = true`, large `max_tokens`) ([K12]). DirectiveBench does not apply vendor
  recommendations implicitly. A suite author may set them. They are recorded and part of the
  comparability key.

## 11. Test strategy

- Recorded fixtures: `GET /v1/models` with capability flags; a streaming chat completion with tool
  calls and final usage; `tool_choice` variants; every error row in §9, including the HTML 504 body
  and the 429 variants distinguished by `error.type`.
- Codec tests: no inner `cache_control` markers on the Messages protocol; `thinking` is sent only when
  configured; streaming is always on.
- Opt-in live test (`DIRECTIVEBENCH_LIVE_TESTS=1` and `MOONSHOT_API_KEY`): list models, then one
  minimal chat completion. Structural assertions only. Never in default CI.

## 12. Acceptance criteria

- [ ] AC-1: A `moonshot` connection validates via `GET /v1/models` and shows `context_length` and
  `supports_reasoning` per model.
- [ ] AC-2: 429 errors are classified by `error.type`. `exceeded_current_quota_error` is never
  retried.
- [ ] AC-3: A 504 with an HTML body is reported as `timeout`, not as a JSON parse failure.
- [ ] AC-4: A 401 shows the regional-platform key hint.
- [ ] AC-5: The Claude Code + Kimi configuration is reachable only through SPEC-203's experimental
  gateway mode, with the settings-file override risk shown to the user.

## 13. Current implementation status

- **Implemented in bootstrap:** nothing.
- **Partially implemented:** none.
- **Not implemented:** the vendor profile, codecs, validation, model discovery, provenance
  signatures, secret storage, the harness, the Claude Code gateway mode, and the Model Providers UI
  (placeholder only).

## 14. Sources

[K1]: https://platform.kimi.ai/docs/guide/product-plans
[K2]: https://platform.kimi.ai/docs/api/overview
[K3]: https://platform.kimi.ai/docs/api/list-models
[K4]: https://platform.kimi.ai/docs/api/signatures-verify
[K5]: https://platform.kimi.ai/docs/guide/claude-code-kimi
[K6]: https://platform.kimi.ai/docs/llms.txt
[K7]: https://platform.kimi.ai/docs/api/errors
[K8]: https://platform.kimi.ai/docs/guide/use-tool-choice
[K9]: https://platform.kimi.ai/docs/api/messages
[K10]: https://platform.kimi.ai/docs/introduction
[K11]: https://platform.kimi.ai/docs/pricing/limits
[K12]: https://platform.kimi.ai/docs/guide/benchmark-best-practice
[C2]: https://code.claude.com/docs/en/llm-gateway

- [K1] Compare with other Kimi products — https://platform.kimi.ai/docs/guide/product-plans
- [K2] API overview — https://platform.kimi.ai/docs/api/overview
- [K3] List models — https://platform.kimi.ai/docs/api/list-models
- [K4] Verify request signature — https://platform.kimi.ai/docs/api/signatures-verify
- [K5] Use Kimi in Claude Code — https://platform.kimi.ai/docs/guide/claude-code-kimi
- [K6] Documentation index (page summaries for models, tool calls, streaming, JSON mode, thinking, ZDR, agent guides) — https://platform.kimi.ai/docs/llms.txt
- [K7] Common error codes — https://platform.kimi.ai/docs/api/errors
- [K8] Tool choice — https://platform.kimi.ai/docs/guide/use-tool-choice
- [K9] Messages API — https://platform.kimi.ai/docs/api/messages
- [K10] Main concepts — https://platform.kimi.ai/docs/introduction
- [K11] Recharge and rate limiting — https://platform.kimi.ai/docs/pricing/limits
- [K12] Benchmarking best practices — https://platform.kimi.ai/docs/guide/benchmark-best-practice
- [C2] Claude Code, other LLM gateways — https://code.claude.com/docs/en/llm-gateway
