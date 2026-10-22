import { describe, expect, it } from 'vitest';
import {
  CLAUDE_STREAM_MAX_EVENTS,
  CLAUDE_STREAM_MAX_LINE_BYTES,
  CLAUDE_STREAM_MAX_NAMES,
  CLAUDE_STREAM_MAX_CALL_ID_CHARS,
  CLAUDE_STREAM_MAX_SKILL_CALLS,
  CLAUDE_TRACE_INPUT_MAX_DEPTH,
  CLAUDE_STREAM_NAME_MAX_CHARS,
  CLAUDE_STREAM_RAW_TAIL_CHARS,
  CLAUDE_TRACE_MAX_EVENTS,
  CLAUDE_TRACE_TEXT_MAX_CHARS,
  ClaudeStreamParser,
  parseClaudeStream,
  promptInvokesSkill,
  redactStreamText,
  type ClaudeStreamOptions,
} from '../../src/claude-code';
import { fixture } from './helpers';

const SKILL: ClaudeStreamOptions = { skillName: 'pdf', prompt: 'Summarise report.pdf' };

const init = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'm1',
    tools: ['Read', 'Skill'],
    skills: ['pdf'],
    apiKeySource: 'none',
    ...extra,
  });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: { model: 'm1', content },
    parent_tool_use_id: null,
    ...extra,
  });
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { content }, parent_tool_use_id: null, ...extra });
const result = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', ...extra });
const lines = (...items: string[]) => `${items.join('\n')}\n`;

describe('parseClaudeStream on recorded-format fixtures', () => {
  it('reads the execution model, reported models, usage and a successful Skill call', () => {
    const parsed = parseClaudeStream(fixture('skill-invoked'), SKILL);
    expect(parsed.init).toEqual({
      model: 'claude-sonnet-4-5-20250929',
      skillTool: true,
      skillsListed: true,
      skillListed: true,
      apiKeySource: 'none',
      laterModels: [],
    });
    expect(parsed.messageModels).toEqual(['claude-sonnet-4-5-20250929']);
    expect(parsed.reportedModels).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
    ]);
    expect(parsed.usage).toEqual({
      inputTokens: 1290,
      outputTokens: 352,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 200,
      costUsd: 0.0123,
    });
    expect(parsed.skillInvocations).toBe(1);
    expect(parsed.otherSkills).toEqual([]);
    expect(parsed.result).toEqual({
      subtype: 'success',
      isError: false,
      text: 'Done.',
      errors: [],
      numTurns: 3,
    });
    expect(parsed.trace).toContainEqual({
      type: 'tool-call',
      tool: 'Skill',
      callId: 'toolu_s1',
      input: '{"skill":"pdf"}',
    });
    expect(parsed.trace).toContainEqual({
      type: 'tool-result',
      callId: 'toolu_s1',
      ok: true,
      output: 'Launching skill: pdf',
    });
    expect(parsed.malformedLines).toBe(0);
  });

  it('records denied skills as other skills and a denied call of the installed skill as not invoked', () => {
    const other = parseClaudeStream(fixture('other-skill-denied'), SKILL);
    expect(other.otherSkills).toEqual(['deploy']);
    expect(other.skillInvocations).toBe(1);
    expect(other.permissionDenials).toBe(1);
    expect(other.trace).toContainEqual({
      type: 'permission-denied',
      tool: 'Skill',
      callId: 'toolu_s2',
    });

    const denied = parseClaudeStream(fixture('skill-call-denied'), SKILL);
    expect(denied.skillInvocations).toBe(0);
    expect(denied.otherSkills).toEqual([]);
    expect(denied.trace).toContainEqual({
      type: 'tool-result',
      callId: 'toolu_s4',
      ok: false,
      output: 'Permission to use Skill has been denied.',
    });
  });

  it('sees a /<name> expansion only for a slash prompt and only with evidence', () => {
    const slash = { skillName: 'pdf', prompt: '/pdf summarise report.pdf' };
    expect(parseClaudeStream(fixture('slash-expanded'), slash).slashExpanded).toBe(true);
    expect(parseClaudeStream(fixture('slash-forked'), slash).slashExpanded).toBe(true);
    expect(parseClaudeStream(fixture('slash-not-expanded'), slash).slashExpanded).toBe(false);
    // Without the slash prompt the same evidence does not count.
    expect(parseClaudeStream(fixture('slash-expanded'), SKILL).slashExpanded).toBe(false);
    expect(parseClaudeStream(fixture('slash-forked'), SKILL).slashExpanded).toBe(false);
  });

  it('records CLI-written error texts and categories', () => {
    const parsed = parseClaudeStream(fixture('rate-limited'), SKILL);
    expect(parsed.apiError).toBe('rate_limit');
    expect(parsed.lastRetryCategory).toBe('rate_limit');
    expect(parsed.syntheticTexts).toEqual(['API Error: Rate limit reached']);
    expect(parsed.messageModels).toEqual([]);
    expect(parsed.trace).toContainEqual({
      type: 'retry',
      attempt: 2,
      category: 'rate_limit',
      httpStatus: 429,
    });
    expect(parsed.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 200,
      costUsd: 0,
    });
  });

  it('redacts secrets from every kept text', () => {
    const parsed = parseClaudeStream(fixture('secret-in-output'), {
      ...SKILL,
      knownSecrets: ['dummy-run-secret-1234'],
    });
    const text = JSON.stringify(parsed.trace);
    expect(text).not.toContain('sk-ant-test-0000000000000000fake');
    expect(text).not.toContain('dummy-run-secret-1234');
    expect(text).toContain('[REDACTED]');
  });

  it('reports a truncated stream as a malformed last line without a result', () => {
    const parsed = parseClaudeStream(fixture('truncated'), SKILL);
    expect(parsed.result).toBeNull();
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.rawTail).toBe('{"type":"result","subtype":"succ');
  });
});

describe('ClaudeStreamParser input handling', () => {
  it('reassembles lines and multi-byte characters split across chunks', () => {
    const text = lines(init(), assistant([{ type: 'text', text: 'zażółć' }]), result());
    const parser = new ClaudeStreamParser(SKILL);
    const bytes = Buffer.from(text, 'utf8');
    for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
    const parsed = parser.end();
    expect(parsed.events).toBe(3);
    expect(parsed.trace).toContainEqual({ type: 'message', text: 'zażółć' });
    expect(parser.end()).toEqual(parsed);
    expect(() => parser.push('x')).toThrow(/already ended/);
  });

  it('ignores blank lines and unknown event types, and rejects non-objects and invalid known events', () => {
    const parsed = parseClaudeStream(
      lines(
        '',
        '   ',
        init(),
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
        JSON.stringify({ type: 'system', subtype: 'status' }),
        '[1,2]',
        'not json',
        JSON.stringify({ type: 'system', subtype: 'init', model: 1 }),
        JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 'x' }),
        JSON.stringify({ type: 'assistant', message: {} }),
        JSON.stringify({ type: 'assistant', message: { content: [], model: 3 } }),
        JSON.stringify({ type: 'user', message: { content: 5 } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
        result(),
      ),
      SKILL,
    );
    expect(parsed.events).toBe(12);
    expect(parsed.malformedLines).toBe(8);
    expect(parsed.result?.subtype).toBe('success');
  });

  it('drops an over-long line without buffering it and keeps parsing after it', () => {
    const parser = new ClaudeStreamParser(SKILL);
    parser.push(`${init()}\n`);
    const big = Buffer.alloc(1024 * 1024, 0x61);
    parser.push('{"type":"user","message":{"content":"');
    for (let i = 0; i <= CLAUDE_STREAM_MAX_LINE_BYTES / big.length; i += 1) parser.push(big);
    parser.push(big); // still skipping
    parser.push(`"}}\n${result()}\n`);
    const parsed = parser.end();
    expect(parsed.oversizedLines).toBe(1);
    expect(parsed.rawTail).toMatch(/^\[line over 8388608 bytes\] \{"type":"user"/);
    expect(parsed.result?.subtype).toBe('success');
    expect(parsed.events).toBe(2);
  });

  it('redacts the head of a dropped line before cutting it (review M3)', () => {
    const key = `sk-ant-test-${'k'.repeat(60)}`;
    const parser = new ClaudeStreamParser({ ...SKILL, knownSecrets: [key] });
    parser.push(`${'a'.repeat(230)}${key}`);
    parser.push(Buffer.alloc(CLAUDE_STREAM_MAX_LINE_BYTES, 0x61));
    const parsed = parser.end();
    expect(parsed.rawTail).toBe(
      `[line over 8388608 bytes] ${'a'.repeat(230)}[REDACTED]${'a'.repeat(16)}`,
    );
  });

  it('redacts a secret split across the chunks before a dropped line (Codex review)', () => {
    const key = `sk-ant-test-${'k'.repeat(14)}`;
    const parser = new ClaudeStreamParser({ ...SKILL, knownSecrets: [key] });
    parser.push(`{"a":"${key.slice(0, 25)}`);
    parser.push(key.slice(25));
    parser.push(Buffer.alloc(CLAUDE_STREAM_MAX_LINE_BYTES, 0x61));
    const parsed = parser.end();
    expect(parsed.rawTail).toBe(
      `[line over 8388608 bytes] {"a":"[REDACTED]${'a'.repeat(256 - 6 - 10)}`,
    );
  });

  it('drops a final over-long line without a newline', () => {
    const parser = new ClaudeStreamParser(SKILL);
    parser.push(Buffer.alloc(CLAUDE_STREAM_MAX_LINE_BYTES + 1, 0x61));
    const parsed = parser.end();
    expect(parsed.oversizedLines).toBe(1);
    expect(parsed.events).toBe(0);
  });

  it('stops counting events after the event limit', () => {
    const event = JSON.stringify({ type: 'stream_event' });
    const parsed = parseClaudeStream(
      `${`${event}\n`.repeat(CLAUDE_STREAM_MAX_EVENTS)}${result()}\n`,
      SKILL,
    );
    expect(parsed.events).toBe(CLAUDE_STREAM_MAX_EVENTS);
    expect(parsed.eventsOverflow).toBe(true);
    expect(parsed.result).toBeNull();
  });

  it('keeps at most the trace limit and counts the rest', () => {
    const message = assistant([{ type: 'text', text: 'x' }]);
    const parsed = parseClaudeStream(
      lines(...Array.from({ length: CLAUDE_TRACE_MAX_EVENTS + 5 }, () => message)),
      SKILL,
    );
    expect(parsed.trace).toHaveLength(CLAUDE_TRACE_MAX_EVENTS);
    expect(parsed.droppedTraceEvents).toBe(5);
  });

  it('truncates long texts and the raw tail', () => {
    const long = 'y'.repeat(CLAUDE_TRACE_TEXT_MAX_CHARS + 10);
    const parsed = parseClaudeStream(
      lines(assistant([{ type: 'text', text: long }]), `x${long}${long}`),
      SKILL,
    );
    expect(parsed.trace[0]).toEqual({
      type: 'message',
      text: `${'y'.repeat(CLAUDE_TRACE_TEXT_MAX_CHARS)}… [truncated]`,
    });
    expect(parsed.rawTail).toBe(`…${'y'.repeat(CLAUDE_STREAM_RAW_TAIL_CHARS)}`);
  });
});

describe('ClaudeStreamParser events', () => {
  it('records a later init with another model, bounded', () => {
    const parsed = parseClaudeStream(
      lines(
        init(),
        init(),
        ...Array.from({ length: CLAUDE_STREAM_MAX_NAMES + 2 }, (_, i) =>
          init({ model: `m${i + 2}` }),
        ),
      ),
      SKILL,
    );
    expect(parsed.init?.model).toBe('m1');
    expect(parsed.init?.laterModels).toHaveLength(CLAUDE_STREAM_MAX_NAMES);
  });

  it('reads an init without skills or apiKeySource, and without a skill name', () => {
    const parsed = parseClaudeStream(
      lines(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1', tools: ['Read'] })),
      { prompt: 'x' },
    );
    expect(parsed.init).toEqual({
      model: 'm1',
      skillTool: false,
      skillsListed: false,
      skillListed: false,
      apiKeySource: null,
      laterModels: [],
    });
    expect(parsed.trace[0]).toEqual({
      type: 'message',
      text: 'Claude Code session started: model m1, 1 tools, 0 skills',
    });
  });

  it('records a retry without a status', () => {
    const parsed = parseClaudeStream(
      lines(
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          error: 'overloaded',
          error_status: null,
        }),
      ),
      SKILL,
    );
    expect(parsed.trace).toEqual([{ type: 'retry', attempt: 1, category: 'overloaded' }]);
  });

  it('separates main-conversation, subagent and synthetic messages', () => {
    const parsed = parseClaudeStream(
      lines(
        assistant('plain string content'),
        assistant([{ type: 'text', text: 'sub' }], {
          message: { model: 'sub-model', content: [] },
          parent_tool_use_id: 'toolu_x',
        }),
        assistant([], { message: { content: [{ type: 'thinking', thinking: '…' }] } }),
        assistant([{ type: 'text', text: 'boom' }], {
          message: { model: '<synthetic>', content: [{ type: 'text', text: 'boom' }] },
          error: 'unknown',
        }),
      ),
      SKILL,
    );
    expect(parsed.messageModels).toEqual(['m1']);
    expect(parsed.syntheticTexts).toEqual(['boom']);
    expect(parsed.apiError).toBe('unknown');
    expect(parsed.trace).toEqual([
      { type: 'message', text: 'plain string content' },
      { type: 'message', text: 'boom' },
    ]);
  });

  it('bounds model sets, error categories and synthetic texts', () => {
    const many = Array.from({ length: CLAUDE_STREAM_MAX_NAMES + 2 }, (_, i) =>
      assistant([], {
        message: {
          model: i === 0 ? '<synthetic>' : `model-${i}`,
          content: [{ type: 'text', text: 'e' }],
        },
        error: 'unknown',
      }),
    );
    const synthetic = Array.from({ length: CLAUDE_STREAM_MAX_NAMES + 1 }, () =>
      assistant([], { message: { model: '<synthetic>', content: [{ type: 'text', text: 'e' }] } }),
    );
    const parsed = parseClaudeStream(lines(...many, ...synthetic), SKILL);
    expect(parsed.messageModels).toHaveLength(CLAUDE_STREAM_MAX_NAMES);
    expect(parsed.modelsOverflow).toBe(true);
    expect(parsed.apiError).toBe('unknown');
    expect(parsed.syntheticTexts).toHaveLength(CLAUDE_STREAM_MAX_NAMES);

    const usage = Object.fromEntries(
      Array.from({ length: CLAUDE_STREAM_MAX_NAMES + 1 }, (_, i) => [`r${i}`, {}]),
    );
    const reported = parseClaudeStream(lines(result({ modelUsage: usage })), SKILL);
    expect(reported.reportedModels).toHaveLength(CLAUDE_STREAM_MAX_NAMES);
    expect(reported.modelsOverflow).toBe(true);
    expect(reported.usage).toBeNull();
  });

  it('tracks Skill calls: unnamed, slash-prefixed, other, unanswered and over the call limit', () => {
    const use = (id: string, input: unknown) =>
      assistant([{ type: 'tool_use', id, name: 'Skill', input }]);
    const answer = (id: string, isError?: boolean) =>
      user([
        {
          type: 'tool_result',
          tool_use_id: id,
          content: { odd: true },
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ]);
    const parsed = parseClaudeStream(
      lines(
        use('a', { skill: '/pdf' }),
        answer('a', false),
        use('b', {}),
        use('c', { skill: 'deploy' }),
        use('d', { skill: 'pdf' }),
        answer('unknown-call'),
        user([{ type: 'image', source: {} }]),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'm1',
            content: [{ type: 'tool_use', id: 'e', name: 'Read', input: null }],
          },
          parent_tool_use_id: null,
        }),
        result({
          permission_denials: [
            { tool_name: 'Skill', tool_input: {} },
            { tool_name: 'Skill', tool_use_id: 'd', tool_input: { skill: 'pdf' } },
            { tool_name: 'Edit', tool_use_id: 'f', tool_input: { file_path: '/etc/x' } },
          ],
        }),
      ),
      SKILL,
    );
    expect(parsed.skillInvocations).toBe(1);
    expect(parsed.otherSkills).toEqual(['(unnamed)', 'deploy']);
    expect(parsed.permissionDenials).toBe(3);
    expect(parsed.trace).toContainEqual({ type: 'tool-result', callId: 'a', ok: true });
    expect(parsed.trace).toContainEqual({
      type: 'tool-call',
      tool: 'Read',
      callId: 'e',
      input: 'null',
    });
    expect(parsed.trace).toContainEqual({ type: 'permission-denied', tool: 'Skill' });

    const calls = Array.from({ length: CLAUDE_STREAM_MAX_SKILL_CALLS + 1 }, (_, i) =>
      use(`s${i}`, { skill: 'pdf' }),
    );
    const answers = Array.from({ length: CLAUDE_STREAM_MAX_SKILL_CALLS + 1 }, (_, i) =>
      answer(`s${i}`),
    );
    expect(parseClaudeStream(lines(...calls, ...answers), SKILL).skillInvocations).toBe(
      CLAUDE_STREAM_MAX_SKILL_CALLS,
    );
  });

  it('reads tool results given as text blocks and stops collecting once the kept part is full', () => {
    const block = { type: 'text', text: 'z'.repeat(4_000) };
    const parsed = parseClaudeStream(
      lines(
        user([
          {
            type: 'tool_result',
            tool_use_id: 't',
            content: [{ type: 'image' }, block, block, block],
          },
        ]),
      ),
      SKILL,
    );
    expect(parsed.trace[0]).toMatchObject({ type: 'tool-result', callId: 't', ok: true });
    expect((parsed.trace[0] as { output: string }).output).toHaveLength(
      CLAUDE_TRACE_TEXT_MAX_CHARS + '… [truncated]'.length,
    );
  });

  it('sees expansion only in main user messages before the first main assistant message', () => {
    const slash = { skillName: 'pdf', prompt: '/pdf' };
    const tag = '<command-name>/pdf</command-name>';
    expect(
      parseClaudeStream(lines(user(tag, { parent_tool_use_id: 'toolu_x' })), slash).slashExpanded,
    ).toBe(false);
    expect(parseClaudeStream(lines(assistant('hi'), user(tag)), slash).slashExpanded).toBe(false);
    expect(
      parseClaudeStream(lines(user('<command-name>/other</command-name>')), slash).slashExpanded,
    ).toBe(false);
    expect(
      parseClaudeStream(
        lines(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'forked-command-pdf' })),
        slash,
      ).slashExpanded,
    ).toBe(true);
    expect(
      parseClaudeStream(lines(user('x', { parent_tool_use_id: 'forked-command-pdf' })), slash)
        .slashExpanded,
    ).toBe(true);
    // Only the installed skill's fork counts (review m1).
    expect(
      parseClaudeStream(
        lines(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'forked-command-other' })),
        slash,
      ).slashExpanded,
    ).toBe(false);
    expect(
      parseClaudeStream(
        lines(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 7 })),
        slash,
      ).slashExpanded,
    ).toBe(false);
  });

  it('falls back to the main-loop usage and reads a result without optional fields', () => {
    const parsed = parseClaudeStream(
      lines(
        result({
          result: undefined,
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        }),
      ),
      SKILL,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cachedInputTokens: 1,
      cacheCreationInputTokens: 0,
    });
    expect(parsed.result).toEqual({
      subtype: 'success',
      isError: false,
      text: null,
      errors: [],
      numTurns: null,
    });
    expect(parseClaudeStream(lines(result()), SKILL).usage).toBeNull();
  });
});

describe('names from the stream', () => {
  it('are clipped wherever they are kept', () => {
    const long = 'n'.repeat(CLAUDE_STREAM_NAME_MAX_CHARS + 1);
    const clipped = `${'n'.repeat(CLAUDE_STREAM_NAME_MAX_CHARS)}… [truncated]`;
    const parsed = parseClaudeStream(
      lines(
        init({ model: long, apiKeySource: long }),
        assistant([], { message: { model: long, content: [] }, error: long }),
        JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, error: long }),
        result({ modelUsage: { [long]: {} } }),
      ),
      SKILL,
    );
    expect(parsed.init).toMatchObject({ model: clipped, apiKeySource: clipped });
    expect(parsed.lastRetryCategory).toBe(clipped);
    expect(parsed.apiError).toBe(clipped);
    expect(parsed.messageModels).toEqual([clipped]);
    expect(parsed.reportedModels).toEqual([clipped]);
  });
});

describe('private keys and other secrets (Codex review)', () => {
  const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
  const END = '-----END RSA PRIVATE KEY-----';
  const body = 'Q'.repeat(8_000);

  it('redactStreamText removes every key fragment, failing closed on a missing marker', () => {
    expect(redactStreamText(`a ${BEGIN}${body}${END} b`, [])).toBe(`a ${BEGIN}[REDACTED]${END} b`);
    expect(redactStreamText(`a ${BEGIN}${body}`, [])).toBe(`a ${BEGIN}[REDACTED]`);
    expect(redactStreamText(`${body}${END} b`, [])).toBe(`[REDACTED]${END} b`);
    expect(redactStreamText(`${END} kept ${BEGIN}${body}`, [])).toBe(
      `[REDACTED]${END} kept ${BEGIN}[REDACTED]`,
    );
    expect(redactStreamText(`${BEGIN}${body}${END}${body}${END}`, [])).toBe(
      `${BEGIN}[REDACTED]${END}[REDACTED]${END}`,
    );
    expect(redactStreamText('plain dummy-run-secret-1234', ['dummy-run-secret-1234'])).toBe(
      'plain [REDACTED]',
    );
  });

  it('keeps no key material of a long, partial or split key in the trace', () => {
    const parsed = parseClaudeStream(
      lines(
        assistant([{ type: 'text', text: `see ${BEGIN}${body}${END}` }]),
        assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'id_rsa' } }]),
        user([{ type: 'tool_result', tool_use_id: 't1', content: `${BEGIN}${body}` }]),
        user([
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: `${body}${END}` }],
          },
        ]),
      ),
      SKILL,
    );
    expect(JSON.stringify(parsed.trace)).not.toContain('QQQQ');
  });

  it('redacts a whole malformed line before keeping its tail', () => {
    const parsed = parseClaudeStream(`x${BEGIN}${body}${body}${END}${'z'.repeat(10)}\n`, SKILL);
    expect(parsed.rawTail).not.toContain('QQQQ');
    expect(parsed.rawTail).toBe(`x${BEGIN}[REDACTED]${END}zzzzzzzzzz`);
  });

  it('redacts known secrets in tool inputs before they are serialised (Codex review)', () => {
    const secrets = ['pa"ss-word-1234', 'back\\slash-secret-1234', 'multi\nline-secret-1234'];
    const parsed = parseClaudeStream(
      lines(
        assistant(
          secrets.map((secret, i) => ({
            type: 'tool_use',
            id: `t${i}`,
            name: 'Write',
            input: { content: `before ${secret} after`, [secret]: 1, nested: [{ deep: secret }] },
          })),
        ),
      ),
      { ...SKILL, knownSecrets: secrets },
    );
    expect(parsed.trace).toHaveLength(3);
    for (const event of parsed.trace) {
      const input = (event as { input: string }).input;
      const decoded = JSON.stringify(JSON.parse(input));
      for (const secret of secrets) {
        expect(input).not.toContain(secret);
        expect(JSON.parse(input).content).not.toContain(secret);
        expect(decoded.includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
      }
      expect(JSON.parse(input)).toEqual({
        content: 'before [REDACTED] after',
        '[REDACTED]': 1,
        nested: [{ deep: '[REDACTED]' }],
      });
    }
  });

  it('redacts a key whose END is in a tool-result block far after the kept prefix (Codex review)', () => {
    const parsed = parseClaudeStream(
      lines(
        user([
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: body },
              { type: 'text', text: `${END} done` },
            ],
          },
        ]),
      ),
      SKILL,
    );
    expect(JSON.stringify(parsed.trace)).not.toContain('QQQQ');
  });

  it('redacts a key whose BEGIN is in the head of a dropped line', () => {
    const parser = new ClaudeStreamParser(SKILL);
    parser.push(`${'a'.repeat(100)}${BEGIN}${body}`);
    parser.push(Buffer.alloc(CLAUDE_STREAM_MAX_LINE_BYTES, 0x51));
    const parsed = parser.end();
    expect(parsed.rawTail).toBe(`[line over 8388608 bytes] ${'a'.repeat(100)}${BEGIN}[REDACTED]`);
  });
});

describe('untrusted shapes (Codex review)', () => {
  it('rejects over-long call ids instead of retaining them', () => {
    const id = 'i'.repeat(1024 * 1024);
    const events = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? assistant([{ type: 'tool_use', id: `${id}${i}`, name: 'Skill', input: { skill: 'pdf' } }])
        : user([{ type: 'tool_result', tool_use_id: `${id}${i}`, content: 'x' }]),
    );
    const parsed = parseClaudeStream(
      lines(
        ...events,
        result({ permission_denials: [{ tool_name: 'Skill', tool_use_id: id, tool_input: {} }] }),
      ),
      SKILL,
    );
    expect(parsed.malformedLines).toBe(9);
    expect(parsed.result).toBeNull();
    expect(parsed.skillInvocations).toBe(0);
    // Nothing of the ids is kept: the whole parse result stays small.
    expect(JSON.stringify(parsed).length).toBeLessThan(10_000);
    const ok = 'k'.repeat(CLAUDE_STREAM_MAX_CALL_ID_CHARS);
    const accepted = parseClaudeStream(
      lines(
        assistant([{ type: 'tool_use', id: ok, name: 'Skill', input: { skill: 'pdf' } }]),
        user([{ type: 'tool_result', tool_use_id: ok, content: 'x' }]),
      ),
      SKILL,
    );
    expect(accepted.skillInvocations).toBe(1);
  });

  it('treats a deeply nested tool input as malformed instead of throwing', () => {
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const line = `{"type":"assistant","message":{"model":"m1","content":[{"type":"tool_use","id":"t","name":"Read","input":${deep}}]},"parent_tool_use_id":null}`;
    const parsed = parseClaudeStream(`${line}\n`, SKILL);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.trace).toEqual([]);
    const nested = (depth: number): unknown => (depth === 0 ? 'leaf' : { a: nested(depth - 1) });
    const ok = parseClaudeStream(
      lines(
        assistant([
          { type: 'tool_use', id: 't', name: 'Read', input: nested(CLAUDE_TRACE_INPUT_MAX_DEPTH) },
        ]),
      ),
      SKILL,
    );
    expect(ok.malformedLines).toBe(0);
    const tooDeep = parseClaudeStream(
      lines(
        assistant([
          {
            type: 'tool_use',
            id: 't',
            name: 'Read',
            input: nested(CLAUDE_TRACE_INPUT_MAX_DEPTH + 1),
          },
        ]),
      ),
      SKILL,
    );
    expect(tooDeep.malformedLines).toBe(1);
  });

  it('skips content blocks that are not objects', () => {
    const parsed = parseClaudeStream(lines(assistant(['x', 3]), user(['x', null])), SKILL);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.trace).toEqual([]);
  });
});

describe('promptInvokesSkill', () => {
  it('needs /<name> followed by whitespace or the end', () => {
    expect(promptInvokesSkill('/pdf', 'pdf')).toBe(true);
    expect(promptInvokesSkill('/pdf\nsummarise', 'pdf')).toBe(true);
    expect(promptInvokesSkill('/pdfx', 'pdf')).toBe(false);
    expect(promptInvokesSkill(' /pdf', 'pdf')).toBe(false);
  });
});

/** Generous bound for the timing test on a loaded 2-core runner (lesson 2026-10-21). */
const LINEAR_TIME_TEST_TIMEOUT_MS = 60_000;

describe('ClaudeStreamParser cost', () => {
  it(
    'is linear in the stream size',
    () => {
      const message = assistant([
        { type: 'tool_use', id: 't', name: 'Skill', input: { skill: 'deploy' } },
      ]);
      // Fastest of three, so one GC pause on a loaded runner cannot fake a ratio.
      const time = (count: number) => {
        const text = lines(...Array.from({ length: count }, () => message));
        let best = Infinity;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = performance.now();
          parseClaudeStream(text, SKILL);
          best = Math.min(best, performance.now() - started);
        }
        return best;
      };
      time(1_000); // warm-up
      const small = Math.max(time(2_500), 1);
      const large = time(20_000);
      // 8× the input; a quadratic parser would take ~64×.
      expect(large / small).toBeLessThan(30);
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});
