import { redactSecrets } from '@directivebench/core';
import { z } from 'zod';
import type { AgentUsage, TraceEvent } from '../contract';

/**
 * Parser for the NDJSON that `claude -p --output-format stream-json --verbose` writes to stdout
 * (SPEC-203 §4, §6; SPEC-118 FR-118-04/09). The output is untrusted: every limit below is named,
 * memory stays bounded whatever the agent prints, the work is linear in the input, and every text
 * kept in the trace is redacted.
 *
 * Field evidence: C1/C7 and the message schemas compiled into the local `claude` 2.1.302 binary
 * (read as strings, no session started; SPEC-203 evidence L3): `system/init` carries `model`,
 * `tools`, `skills` and `apiKeySource`; an assistant message carries `message.model`,
 * `parent_tool_use_id` and an optional `error` category; the `Skill` tool input names the skill
 * in `skill`; a forked skill's messages have a `parent_tool_use_id` starting with
 * `forked-command-`; `result` carries `subtype`, `is_error`, `result`, `errors`, `usage`,
 * `modelUsage`, `total_cost_usd` and `permission_denials`. That these fields behave as read here
 * in a real run is for the opt-in live check (SPEC-118 AC-22).
 */

/** Longest NDJSON line kept; a longer line is dropped (a tool result can hold a large file). */
export const CLAUDE_STREAM_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Lines parsed per agent run; a longer stream fails as `output-parse-error`. */
export const CLAUDE_STREAM_MAX_EVENTS = 50_000;

/** Trace events kept per agent run; later ones are counted, not stored. */
export const CLAUDE_TRACE_MAX_EVENTS = 1_000;

/** Characters kept of one text in the trace (message, tool input or output, error). */
export const CLAUDE_TRACE_TEXT_MAX_CHARS = 2_000;

/** Characters kept of the raw stream tail when the stream cannot be parsed (redacted). */
export const CLAUDE_STREAM_RAW_TAIL_CHARS = 2_000;

/** Distinct names (models, skills) kept per set; more fail closed (see the users of each set). */
export const CLAUDE_STREAM_MAX_NAMES = 64;

/** `Skill` tool calls tracked until their result arrives; later calls count as unconfirmed. */
export const CLAUDE_STREAM_MAX_SKILL_CALLS = 1_000;

/**
 * Text before a cut that is redacted with the kept part, so a secret that starts in the kept part
 * is matched whole (API keys are about 100 characters).
 */
export const CLAUDE_REDACTION_MARGIN_CHARS = 4_096;

/** The prefix of the `parent_tool_use_id` of a forked skill's messages, `forked-command-<name>` (C1, L3). */
export const FORKED_SKILL_PARENT_PREFIX = 'forked-command-';

/** Characters kept of a name from the stream (model, skill, tool, call id, category). */
export const CLAUDE_STREAM_NAME_MAX_CHARS = 200;

/** Characters of an over-long line kept for diagnosis. */
const DROPPED_LINE_HEAD_CHARS = 256;

/** Stands in for a `Skill` call whose input names no skill. */
const UNNAMED_SKILL = '(unnamed)';

/** `message.model` of messages the CLI writes itself (e.g. API errors), not model output. */
const SYNTHETIC_MODEL = '<synthetic>';

export interface ClaudeStreamOptions {
  /** The installed skill's resolved name (`skill-md` only); enables `skillActivation`. */
  skillName?: string;
  /** The case prompt; `/<skillName>` at its start is an explicit invocation (FR-118-09). */
  prompt: string;
  /** Exact secret values (e.g. the API key) removed from every kept text. */
  knownSecrets?: readonly string[];
}

/** What the `system/init` event reported. */
export interface ClaudeInitFacts {
  model: string;
  /** Whether the `Skill` tool is in `tools`. */
  skillTool: boolean;
  /** Whether `skills` was present; when absent, loading is judged by the `Skill` tool alone. */
  skillsListed: boolean;
  /** Whether `skills` lists the installed skill. */
  skillListed: boolean;
  /** `apiKeySource` (L3: `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, `none`). */
  apiKeySource: string | null;
  /** Other models reported by later `system/init` events (none expected). */
  laterModels: string[];
}

export interface ClaudeResultFacts {
  subtype: string;
  isError: boolean;
  /** Final text, redacted and truncated. */
  text: string | null;
  /** `errors[]` of an error subtype, redacted and truncated. */
  errors: string[];
  numTurns: number | null;
}

export interface ParsedClaudeStream {
  /** Lines parsed, valid or not. */
  events: number;
  init: ClaudeInitFacts | null;
  result: ClaudeResultFacts | null;
  trace: TraceEvent[];
  usage: AgentUsage | null;
  /** Models of main-conversation assistant messages (synthetic ones excluded), sorted. */
  messageModels: string[];
  /** Keys of `result.modelUsage`, sorted. */
  reportedModels: string[];
  /** True when a model set exceeded {@link CLAUDE_STREAM_MAX_NAMES}; treated as a mismatch. */
  modelsOverflow: boolean;
  /**
   * `error` category (e.g. `authentication_failed`) of the last main-conversation assistant
   * message; a later main message without one clears it, so a recovered error never counts.
   */
  apiError: string | null;
  /** Category of the last `system/api_retry`, cleared by a later model answer (recovered). */
  lastRetryCategory: string | null;
  /** CLI-written error texts of main-conversation synthetic messages since the last model answer. */
  syntheticTexts: string[];
  permissionDenials: number;
  /** Successful `Skill` calls of the installed skill. */
  skillInvocations: number;
  /** Other skill names attempted, sorted (at most {@link CLAUDE_STREAM_MAX_NAMES}). */
  otherSkills: string[];
  /** A `/<name>` prompt whose expansion the stream shows (FR-118-09). */
  slashExpanded: boolean;
  /** Lines that were not a JSON object or not a valid known event. */
  malformedLines: number;
  /** Lines longer than {@link CLAUDE_STREAM_MAX_LINE_BYTES}, dropped. */
  oversizedLines: number;
  /** True when the stream exceeded {@link CLAUDE_STREAM_MAX_EVENTS}. */
  eventsOverflow: boolean;
  /** Trace events not stored because of {@link CLAUDE_TRACE_MAX_EVENTS}. */
  droppedTraceEvents: number;
  /** Redacted tail of the last malformed or dropped line, for diagnosis. */
  rawTail: string | null;
}

const object = z.looseObject({ type: z.string() });
const initEvent = z.looseObject({
  subtype: z.literal('init'),
  model: z.string(),
  tools: z.array(z.string()),
  skills: z.array(z.string()).optional(),
  apiKeySource: z.string().optional(),
});
const retryEvent = z.looseObject({
  subtype: z.literal('api_retry'),
  attempt: z.number(),
  error: z.string(),
  error_status: z.number().nullish(),
});
const messageEvent = z.looseObject({
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
  parent_tool_use_id: z.string().nullish(),
});
const assistantExtras = z.looseObject({
  message: z.looseObject({ model: z.string().optional() }),
  error: z.string().optional(),
});
const textBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const toolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});
const count = z.number().finite().nonnegative();
const resultEvent = z.looseObject({
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  num_turns: count.optional(),
  total_cost_usd: count.optional(),
  usage: z
    .looseObject({
      input_tokens: count.optional(),
      output_tokens: count.optional(),
      cache_read_input_tokens: count.optional(),
      cache_creation_input_tokens: count.optional(),
    })
    .optional(),
  modelUsage: z
    .record(
      z.string(),
      z.looseObject({
        inputTokens: count.optional(),
        outputTokens: count.optional(),
        cacheReadInputTokens: count.optional(),
        cacheCreationInputTokens: count.optional(),
      }),
    )
    .optional(),
  permission_denials: z
    .array(
      z.looseObject({
        tool_name: z.string(),
        tool_use_id: z.string().optional(),
        tool_input: z.unknown(),
      }),
    )
    .optional(),
});
const skillInput = z.looseObject({ skill: z.string() });

/** A set that keeps at most {@link CLAUDE_STREAM_MAX_NAMES} names and remembers an overflow. */
class BoundedNames {
  readonly names = new Set<string>();
  overflow = false;

  add(name: string): void {
    if (this.names.has(name)) return;
    if (this.names.size >= CLAUDE_STREAM_MAX_NAMES) this.overflow = true;
    else this.names.add(name);
  }

  sorted(): string[] {
    return [...this.names].sort();
  }
}

/** Starts with `/<name>` followed by the end or whitespace (FR-118-09). */
export function promptInvokesSkill(prompt: string, skillName: string): boolean {
  const command = `/${skillName}`;
  return prompt.startsWith(command) && /^(?:\s|$)/.test(prompt.slice(command.length));
}

/**
 * Incremental parser: feed stdout chunks with {@link push} as they arrive and call {@link end}
 * once the process has exited. Holds at most one line ({@link CLAUDE_STREAM_MAX_LINE_BYTES}) plus
 * the bounded state of {@link ParsedClaudeStream}.
 */
export class ClaudeStreamParser {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private skippingLine = false;
  private ended = false;
  private readonly secrets: readonly string[];
  private readonly slashPrompt: boolean;
  private assistantSeen = false;
  private usage: AgentUsage | null = null;
  private readonly messageModels = new BoundedNames();
  private readonly reportedModels = new BoundedNames();
  private readonly otherSkills = new BoundedNames();
  private readonly skillCalls = new Map<string, string>();
  private readonly state: Omit<
    ParsedClaudeStream,
    'messageModels' | 'reportedModels' | 'modelsOverflow' | 'otherSkills' | 'usage'
  > = {
    events: 0,
    init: null,
    result: null,
    trace: [],
    apiError: null,
    lastRetryCategory: null,
    syntheticTexts: [],
    permissionDenials: 0,
    skillInvocations: 0,
    slashExpanded: false,
    malformedLines: 0,
    oversizedLines: 0,
    eventsOverflow: false,
    droppedTraceEvents: 0,
    rawTail: null,
  };

  constructor(private readonly options: ClaudeStreamOptions) {
    this.secrets = options.knownSecrets ?? [];
    this.slashPrompt =
      options.skillName !== undefined && promptInvokesSkill(options.prompt, options.skillName);
  }

  /** Adds a chunk of stdout. Splits on `\n` only, so multi-byte characters survive any split. */
  push(chunk: Buffer | string): void {
    if (this.ended) throw new Error('The stream parser has already ended.');
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const newline = data.indexOf(0x0a);
      const piece = newline === -1 ? data : data.subarray(0, newline);
      if (!this.skippingLine) {
        if (this.buffered + piece.length > CLAUDE_STREAM_MAX_LINE_BYTES) {
          this.dropLine(
            (this.chunks[0] ?? piece).subarray(
              0,
              DROPPED_LINE_HEAD_CHARS + CLAUDE_REDACTION_MARGIN_CHARS,
            ),
          );
        } else if (piece.length > 0) {
          this.chunks.push(piece);
          this.buffered += piece.length;
        }
      }
      if (newline === -1) return;
      if (this.skippingLine) this.skippingLine = false;
      else this.flushLine();
      data = data.subarray(newline + 1);
    }
  }

  /** Parses a final line without a newline and returns the result. */
  end(): ParsedClaudeStream {
    if (!this.ended) {
      if (!this.skippingLine) this.flushLine();
      this.ended = true;
    }
    return {
      ...this.state,
      trace: [...this.state.trace],
      usage: this.usage,
      messageModels: this.messageModels.sorted(),
      reportedModels: this.reportedModels.sorted(),
      modelsOverflow: this.messageModels.overflow || this.reportedModels.overflow,
      otherSkills: this.otherSkills.sorted(),
    };
  }

  private dropLine(head: Buffer): void {
    this.chunks.length = 0;
    this.buffered = 0;
    this.skippingLine = true;
    this.state.oversizedLines += 1;
    // Redacted before it is cut, so a secret that starts in the kept head is matched whole.
    const text = redactSecrets(head.toString('utf8'), this.secrets);
    this.state.rawTail = `[line over ${CLAUDE_STREAM_MAX_LINE_BYTES} bytes] ${text.slice(0, DROPPED_LINE_HEAD_CHARS)}`;
  }

  private flushLine(): void {
    const line = Buffer.concat(this.chunks).toString('utf8');
    this.chunks.length = 0;
    this.buffered = 0;
    if (line.trim() === '') return;
    if (this.state.events >= CLAUDE_STREAM_MAX_EVENTS) {
      this.state.eventsOverflow = true;
      return;
    }
    this.state.events += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.malformed(line);
      return;
    }
    if (!this.handle(value)) this.malformed(line);
  }

  private malformed(line: string): void {
    this.state.malformedLines += 1;
    // The end of the line says where it broke off; only a bounded suffix is ever redacted.
    const redacted = redactSecrets(
      line.slice(-(CLAUDE_STREAM_RAW_TAIL_CHARS + CLAUDE_REDACTION_MARGIN_CHARS)),
      this.secrets,
    );
    this.state.rawTail =
      redacted.length > CLAUDE_STREAM_RAW_TAIL_CHARS
        ? `…${redacted.slice(-CLAUDE_STREAM_RAW_TAIL_CHARS)}`
        : redacted;
  }

  /** Redacts, then truncates; only a bounded prefix is ever redacted. */
  private clip(text: string, max = CLAUDE_TRACE_TEXT_MAX_CHARS): string {
    const redacted = redactSecrets(
      text.slice(0, max + CLAUDE_REDACTION_MARGIN_CHARS),
      this.secrets,
    );
    return redacted.length > max ? `${redacted.slice(0, max)}… [truncated]` : redacted;
  }

  private record(event: TraceEvent): void {
    if (this.state.trace.length >= CLAUDE_TRACE_MAX_EVENTS) this.state.droppedTraceEvents += 1;
    else this.state.trace.push(event);
  }

  /** Returns false for a value that is not a valid event of a known type. */
  private handle(value: unknown): boolean {
    const event = object.safeParse(value);
    if (!event.success) return false;
    switch (event.data.type) {
      case 'system':
        return this.handleSystem(event.data);
      case 'assistant':
        return this.handleAssistant(event.data);
      case 'user':
        return this.handleUser(event.data);
      case 'result':
        return this.handleResult(event.data);
      default:
        // Other event types (stream events, rate-limit notices, …) carry nothing this parser needs.
        this.noteForkedParent(event.data);
        return true;
    }
  }

  private noteForkedParent(event: Record<string, unknown>): void {
    const parent = event.parent_tool_use_id;
    if (
      this.slashPrompt &&
      typeof parent === 'string' &&
      parent === `${FORKED_SKILL_PARENT_PREFIX}${this.options.skillName}`
    ) {
      this.state.slashExpanded = true;
    }
  }

  private handleSystem(event: Record<string, unknown>): boolean {
    if (event.subtype === 'init') {
      const init = initEvent.safeParse(event);
      if (!init.success) return false;
      const data = {
        ...init.data,
        model: this.clip(init.data.model, CLAUDE_STREAM_NAME_MAX_CHARS),
      };
      if (this.state.init) {
        if (
          data.model !== this.state.init.model &&
          this.state.init.laterModels.length < CLAUDE_STREAM_MAX_NAMES
        ) {
          this.state.init.laterModels.push(data.model);
        }
        return true;
      }
      const skillName = this.options.skillName;
      this.state.init = {
        model: data.model,
        skillTool: data.tools.includes('Skill'),
        skillsListed: data.skills !== undefined,
        skillListed: skillName !== undefined && (data.skills ?? []).includes(skillName),
        apiKeySource:
          data.apiKeySource === undefined
            ? null
            : this.clip(data.apiKeySource, CLAUDE_STREAM_NAME_MAX_CHARS),
        laterModels: [],
      };
      this.record({
        type: 'message',
        text: this.clip(
          `Claude Code session started: model ${data.model}, ${data.tools.length} tools, ${data.skills?.length ?? 0} skills`,
        ),
      });
      return true;
    }
    if (event.subtype === 'api_retry') {
      const retry = retryEvent.safeParse(event);
      if (!retry.success) return false;
      this.state.lastRetryCategory = this.clip(retry.data.error, CLAUDE_STREAM_NAME_MAX_CHARS);
      this.record({
        type: 'retry',
        attempt: retry.data.attempt,
        category: this.clip(retry.data.error, CLAUDE_STREAM_NAME_MAX_CHARS),
        ...(typeof retry.data.error_status === 'number'
          ? { httpStatus: retry.data.error_status }
          : {}),
      });
      return true;
    }
    return true;
  }

  private handleAssistant(event: Record<string, unknown>): boolean {
    const parsed = messageEvent.safeParse(event);
    const extras = assistantExtras.safeParse(event);
    if (!parsed.success || !extras.success) return false;
    this.noteForkedParent(event);
    const main = parsed.data.parent_tool_use_id == null;
    const reported = extras.data.message.model;
    const model =
      reported === undefined ? undefined : this.clip(reported, CLAUDE_STREAM_NAME_MAX_CHARS);
    const synthetic = model === SYNTHETIC_MODEL;
    if (main && model !== undefined && !synthetic) this.messageModels.add(model);
    if (main) {
      this.assistantSeen = true;
      const error = extras.data.error;
      // A synthetic message without a category (e.g. a CLI notice) keeps the last error.
      if (error !== undefined) this.state.apiError = this.clip(error, CLAUDE_STREAM_NAME_MAX_CHARS);
      else if (!synthetic) this.state.apiError = null;
      // A model answer means the API recovered: earlier retries and CLI-written errors are over.
      if (!synthetic) {
        this.state.lastRetryCategory = null;
        this.state.syntheticTexts.length = 0;
      }
    }
    const content = parsed.data.message.content;
    for (const block of typeof content === 'string' ? [{ type: 'text', text: content }] : content) {
      const text = textBlock.safeParse(block);
      if (text.success) {
        const clipped = this.clip(text.data.text);
        if (main && synthetic && this.state.syntheticTexts.length < CLAUDE_STREAM_MAX_NAMES) {
          this.state.syntheticTexts.push(clipped);
        }
        this.record({ type: 'message', text: clipped });
        continue;
      }
      const toolUse = toolUseBlock.safeParse(block);
      if (!toolUse.success) continue;
      const { id, name, input } = toolUse.data;
      this.record({
        type: 'tool-call',
        tool: this.clip(name, CLAUDE_STREAM_NAME_MAX_CHARS),
        callId: this.clip(id, CLAUDE_STREAM_NAME_MAX_CHARS),
        input: this.clip(JSON.stringify(input)),
      });
      if (name === 'Skill') this.noteSkillCall(id, input);
    }
    return true;
  }

  private noteSkillCall(callId: string, input: unknown): void {
    const parsed = skillInput.safeParse(input);
    const skill = parsed.success ? parsed.data.skill.replace(/^\//, '') : UNNAMED_SKILL;
    if (skill !== this.options.skillName) {
      this.otherSkills.add(this.clip(skill, CLAUDE_STREAM_NAME_MAX_CHARS));
      return;
    }
    if (this.skillCalls.size < CLAUDE_STREAM_MAX_SKILL_CALLS) this.skillCalls.set(callId, skill);
  }

  private handleUser(event: Record<string, unknown>): boolean {
    const parsed = messageEvent.safeParse(event);
    if (!parsed.success) return false;
    this.noteForkedParent(event);
    const main = parsed.data.parent_tool_use_id == null;
    const content = parsed.data.message.content;
    for (const block of typeof content === 'string' ? [{ type: 'text', text: content }] : content) {
      const text = textBlock.safeParse(block);
      if (text.success) {
        if (main && !this.assistantSeen) this.noteExpansion(text.data.text);
        continue;
      }
      const result = toolResultBlock.safeParse(block);
      if (!result.success) continue;
      const ok = result.data.is_error !== true;
      const output = toolResultText(result.data.content);
      this.record({
        type: 'tool-result',
        callId: this.clip(result.data.tool_use_id, CLAUDE_STREAM_NAME_MAX_CHARS),
        ok,
        ...(output === '' ? {} : { output: this.clip(output) }),
      });
      if (this.skillCalls.delete(result.data.tool_use_id) && ok) this.state.skillInvocations += 1;
    }
    return true;
  }

  /**
   * Inline expansion of a `/<name>` prompt (FR-118-09): a user message before the first assistant
   * turn naming the command in the CLI's `<command-name>` tag. **Assumption — requires
   * validation by the live check (SPEC-118 AC-22):** that print mode emits this message.
   */
  private noteExpansion(text: string): void {
    if (
      this.slashPrompt &&
      text.includes(`<command-name>/${this.options.skillName}</command-name>`)
    ) {
      this.state.slashExpanded = true;
    }
  }

  private handleResult(event: Record<string, unknown>): boolean {
    const parsed = resultEvent.safeParse(event);
    if (!parsed.success) return false;
    const data = parsed.data;
    this.state.result = {
      subtype: this.clip(data.subtype, CLAUDE_STREAM_NAME_MAX_CHARS),
      isError: data.is_error,
      text: data.result === undefined ? null : this.clip(data.result),
      errors: (data.errors ?? []).slice(0, CLAUDE_STREAM_MAX_NAMES).map((e) => this.clip(e)),
      numTurns: data.num_turns ?? null,
    };
    for (const model of Object.keys(data.modelUsage ?? {})) {
      this.reportedModels.add(this.clip(model, CLAUDE_STREAM_NAME_MAX_CHARS));
    }
    this.usage = usageOf(data);
    for (const denial of data.permission_denials ?? []) {
      this.state.permissionDenials += 1;
      this.record({
        type: 'permission-denied',
        tool: this.clip(denial.tool_name, CLAUDE_STREAM_NAME_MAX_CHARS),
        ...(denial.tool_use_id === undefined
          ? {}
          : { callId: this.clip(denial.tool_use_id, CLAUDE_STREAM_NAME_MAX_CHARS) }),
      });
      if (denial.tool_name === 'Skill') {
        const skill = skillInput.safeParse(denial.tool_input);
        const name = skill.success ? skill.data.skill.replace(/^\//, '') : UNNAMED_SKILL;
        if (name !== this.options.skillName)
          this.otherSkills.add(this.clip(name, CLAUDE_STREAM_NAME_MAX_CHARS));
      }
    }
    return true;
  }
}

/** Text of a `tool_result` content: a string, or the text blocks of an array. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  let length = 0;
  for (const block of content) {
    const text = textBlock.safeParse(block);
    if (!text.success) continue;
    texts.push(text.data.text);
    length += text.data.text.length;
    // Enough to fill the kept prefix; the rest would be cut anyway.
    if (length > CLAUDE_TRACE_TEXT_MAX_CHARS + CLAUDE_REDACTION_MARGIN_CHARS) break;
  }
  return texts.join('\n');
}

/** Token usage summed over `modelUsage` (all models), else the main-loop `usage`. */
function usageOf(result: z.infer<typeof resultEvent>): AgentUsage | null {
  const usage: AgentUsage = {};
  const add = (key: keyof AgentUsage, value: number | undefined) => {
    if (value !== undefined) usage[key] = (usage[key] ?? 0) + value;
  };
  const perModel = Object.values(result.modelUsage ?? {});
  if (perModel.length > 0) {
    for (const model of perModel) {
      add('inputTokens', model.inputTokens);
      add('outputTokens', model.outputTokens);
      add('cachedInputTokens', model.cacheReadInputTokens);
      add('cacheCreationInputTokens', model.cacheCreationInputTokens);
    }
  } else if (result.usage) {
    add('inputTokens', result.usage.input_tokens);
    add('outputTokens', result.usage.output_tokens);
    add('cachedInputTokens', result.usage.cache_read_input_tokens);
    add('cacheCreationInputTokens', result.usage.cache_creation_input_tokens);
  }
  add('costUsd', result.total_cost_usd);
  return Object.keys(usage).length > 0 ? usage : null;
}

/** Parses a complete stream (e.g. a recorded fixture). */
export function parseClaudeStream(
  output: Buffer | string,
  options: ClaudeStreamOptions,
): ParsedClaudeStream {
  const parser = new ClaudeStreamParser(options);
  parser.push(output);
  return parser.end();
}
