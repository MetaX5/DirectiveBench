import { describe, expect, it } from 'vitest';
import {
  CLAUDE_STREAM_MAX_EVENTS,
  TOO_MANY_MODELS,
  classifyClaudeRun,
  claudeRunMetadata,
  claudeRunOutcome,
  claudeSkillActivation,
  parseClaudeStream,
  type ClaudeRunConditions,
  type ParsedClaudeStream,
} from '../../src/claude-code';
import { fixture } from './helpers';

const SKILL = { skillName: 'pdf', prompt: 'Summarise report.pdf' };
const parse = (name: string, prompt = SKILL.prompt) =>
  parseClaudeStream(fixture(name), { ...SKILL, prompt });
const OK = { exitCode: 0 };

const conditions = (overrides: Partial<ClaudeRunConditions> = {}): ClaudeRunConditions => ({
  adapterVersion: '2.1.302',
  authMode: 'subscription',
  permissionProfile: 'edit-only',
  requestedModel: null,
  flagsHash: 'f'.repeat(64),
  skill: true,
  ...overrides,
});

describe('classifyClaudeRun on recorded-format fixtures (SPEC-203 §9)', () => {
  it.each([
    ['skill-invoked', 'subscription', OK, 'completed', null],
    ['api-key-success', 'api-key', OK, 'completed', null],
    ['retry-recovered', 'subscription', OK, 'completed', null],
    ['auth-expired', 'subscription', { exitCode: 1 }, 'agent-error', 'auth-expired'],
    ['auth-invalid', 'api-key', { exitCode: 1 }, 'agent-error', 'auth-invalid'],
    ['rate-limited', 'subscription', { exitCode: 1 }, 'agent-error', 'rate-limited'],
    ['usage-limit', 'subscription', OK, 'agent-error', 'rate-limited'],
    ['billing', 'api-key', { exitCode: 1 }, 'agent-error', 'billing'],
    ['max-budget', 'api-key', { exitCode: 1 }, 'agent-error', 'budget-exceeded'],
    ['max-turns', 'subscription', { exitCode: 1 }, 'agent-error', 'agent-failed'],
    ['truncated', 'subscription', { exitCode: 1 }, 'agent-error', 'output-parse-error'],
    // The api-key run's credential source in subscription mode, and the other way round.
    ['api-key-success', 'subscription', OK, 'agent-error', 'auth-mismatch'],
    ['skill-invoked', 'api-key', OK, 'agent-error', 'auth-mismatch'],
  ] as const)('%s in %s mode → %s %s', (name, mode, exit, status, code) => {
    const classification = classifyClaudeRun(parse(name), exit, mode);
    expect(classification.status).toBe(status);
    expect(classification.errorCode).toBe(code);
  });

  it('warns on ambient configuration, denials, truncation and an is_error success', () => {
    expect(classifyClaudeRun(parse('other-skill-denied'), OK, 'subscription').warnings).toEqual([
      'ambient-user-config',
      'permission-denied',
    ]);
    expect(classifyClaudeRun(parse('api-key-success'), OK, 'api-key').warnings).toEqual([]);
    const reported = classifyClaudeRun(parse('agent-reported-error'), OK, 'subscription');
    expect(reported).toEqual({
      status: 'completed',
      errorCode: null,
      error: null,
      warnings: ['ambient-user-config', 'agent-reported-error'],
    });
    const truncated = { ...parse('skill-invoked'), droppedTraceEvents: 3 };
    expect(classifyClaudeRun(truncated, OK, 'api-key').warnings).toContain('trace-truncated');
    const oversized = { ...parse('skill-invoked'), oversizedLines: 1 };
    expect(classifyClaudeRun(oversized, OK, 'api-key').warnings).toContain('trace-truncated');
  });

  it('names the credential source in an auth-mismatch, also when none was reported', () => {
    const parsed = parse('skill-invoked');
    expect(classifyClaudeRun(parsed, OK, 'api-key').error).toBe(
      'Claude Code used the credential source "none", not the one of api-key mode ("ANTHROPIC_API_KEY").',
    );
    const unreported: ParsedClaudeStream = {
      ...parsed,
      init: { ...(parsed.init as NonNullable<ParsedClaudeStream['init']>), apiKeySource: null },
    };
    expect(classifyClaudeRun(unreported, OK, 'subscription')).toMatchObject({
      errorCode: 'auth-mismatch',
      error: expect.stringContaining('"not reported"'),
    });
  });

  it('prefers the expired-login text to the authentication_failed category', () => {
    expect(classifyClaudeRun(parse('auth-expired'), { exitCode: 1 }, 'subscription').error).toBe(
      'Claude Code failed (auth-expired): Login expired · Please run /login',
    );
  });

  it('maps every reported category and an unknown one', () => {
    const base = parse('skill-invoked');
    const run = (category: string): string | null =>
      classifyClaudeRun(
        { ...base, apiError: category, result: { ...base.result!, isError: true, text: 'x' } },
        OK,
        'subscription',
      ).errorCode;
    expect(run('oauth_org_not_allowed')).toBe('auth-invalid');
    expect(run('account_on_hold')).toBe('auth-invalid');
    expect(run('verification_required')).toBe('auth-invalid');
    expect(run('cloud_credential_error')).toBe('auth-invalid');
    expect(run('overloaded')).toBe('rate-limited');
    expect(run('model_not_found')).toBe('model-not-found');
    expect(run('server_error')).toBe('provider-error');
  });

  it('uses the last retry category only when the run had no regular error subtype', () => {
    const base = parse('skill-invoked');
    const noResult = { ...base, result: null, lastRetryCategory: 'rate_limit' };
    expect(classifyClaudeRun(noResult, { exitCode: 1 }, 'subscription')).toMatchObject({
      errorCode: 'rate-limited',
      error: 'Claude Code failed (rate-limited): rate_limit',
    });
    const maxTurns = { ...parse('max-turns'), lastRetryCategory: 'rate_limit' };
    expect(classifyClaudeRun(maxTurns, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'agent-failed',
    );
  });

  it('reads auth, billing and quota failures from CLI-written text when no category is reported', () => {
    const base = parse('skill-invoked');
    const run = (text: string, where: 'errors' | 'synthetic' = 'synthetic') =>
      classifyClaudeRun(
        where === 'synthetic'
          ? { ...base, syntheticTexts: [text], result: { ...base.result!, isError: true } }
          : {
              ...base,
              result: {
                ...base.result!,
                subtype: 'error_during_execution',
                isError: true,
                errors: [text],
              },
            },
        { exitCode: 1 },
        'subscription',
      ).errorCode;
    expect(run('Not logged in · Please run /login')).toBe('auth-missing');
    expect(run('Invalid API key · Fix external API key')).toBe('auth-invalid');
    expect(run('Credit balance is too low')).toBe('billing');
    expect(run('Claude AI usage limit reached|1760000000')).toBe('rate-limited');
    expect(run('5-hour limit reached ∙ resets 3pm', 'errors')).toBe('rate-limited');
    expect(run('first line\nOAuth token has expired.', 'errors')).toBe('auth-expired');
    // A message the CLI wrote without a known wording: a provider error, which does not stop.
    expect(run('Something else went wrong')).toBe('provider-error');
    expect(run('Something else went wrong', 'errors')).toBe('agent-failed');
  });

  it("never reads the agent's own answer as a login or quota failure (review M2)", () => {
    const base = parse('skill-invoked');
    const answer =
      'I added rate limit middleware. Login expired sessions now redirect; please run /login.';
    const reported = { ...base, result: { ...base.result!, isError: true, text: answer } };
    expect(classifyClaudeRun(reported, OK, 'subscription')).toMatchObject({
      status: 'completed',
      warnings: ['ambient-user-config', 'agent-reported-error'],
    });
    expect(classifyClaudeRun(reported, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'agent-failed',
    );
    const inErrors = {
      ...base,
      result: {
        ...base.result!,
        subtype: 'error_during_execution',
        isError: true,
        errors: [`Tool failed: ${answer}`],
      },
    };
    expect(classifyClaudeRun(inErrors, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'agent-failed',
    );
  });

  it('never lets a recovered retry or a subagent error decide a later failure (review M1)', () => {
    const lines = (...items: object[]) => items.map((item) => JSON.stringify(item)).join('\n');
    const init = {
      type: 'system',
      subtype: 'init',
      model: 'm1',
      tools: ['Skill'],
      skills: ['pdf'],
      apiKeySource: 'none',
    };
    const retry = (error: string) => ({ type: 'system', subtype: 'api_retry', attempt: 1, error });
    const answer = {
      type: 'assistant',
      message: { model: 'm1', content: [{ type: 'text', text: 'working' }] },
      parent_tool_use_id: null,
    };
    const ok = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    const maxTurns = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['Reached maximum number of turns'],
    };

    const killed = parseClaudeStream(lines(init, retry('overloaded'), answer), SKILL);
    expect(killed.lastRetryCategory).toBeNull();
    expect(classifyClaudeRun(killed, { exitCode: 137 }, 'subscription').errorCode).toBe(
      'output-parse-error',
    );

    const exitOne = parseClaudeStream(lines(init, retry('rate_limit'), answer, ok), SKILL);
    expect(classifyClaudeRun(exitOne, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'agent-failed',
    );

    const subagent = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: Rate limit reached' }],
      },
      parent_tool_use_id: 'toolu_sub',
      error: 'rate_limit',
    };
    const sub = parseClaudeStream(lines(init, subagent, maxTurns), SKILL);
    expect(sub.apiError).toBeNull();
    expect(sub.syntheticTexts).toEqual([]);
    expect(classifyClaudeRun(sub, { exitCode: 1 }, 'subscription').errorCode).toBe('agent-failed');

    const mainError = { ...subagent, parent_tool_use_id: null };
    // A later synthetic message without a category keeps the error (review r2-m1).
    const notice = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
      parent_tool_use_id: null,
    };
    const isError = { ...ok, is_error: true };
    const kept = parseClaudeStream(lines(init, mainError, notice, isError), SKILL);
    expect(kept.apiError).toBe('rate_limit');
    expect(classifyClaudeRun(kept, { exitCode: 1 }, 'subscription').errorCode).toBe('rate-limited');
    const recovered = parseClaudeStream(lines(init, mainError, answer, maxTurns), SKILL);
    expect(recovered.apiError).toBeNull();
    expect(classifyClaudeRun(recovered, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'agent-failed',
    );
  });

  it('stops on a login or quota message printed outside the stream (review m3)', () => {
    const plain = parseClaudeStream('Not logged in · Please run /login\n', SKILL);
    expect(classifyClaudeRun(plain, { exitCode: 1 }, 'subscription')).toMatchObject({
      errorCode: 'auth-missing',
      error: 'Claude Code failed (auth-missing): Not logged in · Please run /login',
    });
    const empty = parseClaudeStream('', SKILL);
    expect(
      classifyClaudeRun(
        empty,
        { exitCode: 1, stderr: 'warning: x\nInvalid API key · Fix external API key\n' },
        'api-key',
      ),
    ).toMatchObject({ errorCode: 'auth-invalid' });
    const both = parseClaudeStream('Credit balance is too low\n', SKILL);
    expect(classifyClaudeRun(both, { exitCode: 1, stderr: 'exit' }, 'api-key').error).toBe(
      'Claude Code failed (billing): Credit balance is too low / exit',
    );
  });

  it('never completes a stream without a session start (Codex review)', () => {
    const resultOnly = parseClaudeStream(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })}\n`,
      SKILL,
    );
    expect(classifyClaudeRun(resultOnly, OK, 'subscription')).toMatchObject({
      status: 'agent-error',
      errorCode: 'output-parse-error',
      error: 'Claude Code output could not be read: the stream has no session start (system/init).',
    });
    // An early failure keeps its code.
    const expired = parseClaudeStream(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'x', errors: [] })}\n${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Login expired · Please run /login' }] }, parent_tool_use_id: null })}\n`,
      SKILL,
    );
    expect(classifyClaudeRun(expired, { exitCode: 1 }, 'subscription').errorCode).toBe(
      'auth-expired',
    );
  });

  it('redacts a private key that straddles the kept end of stderr (Codex review)', () => {
    const stderr = `-----BEGIN PRIVATE KEY-----${'Q'.repeat(8_000)}-----END PRIVATE KEY-----\ndone`;
    const error = classifyClaudeRun(
      parseClaudeStream('', SKILL),
      { exitCode: 2, stderr },
      'subscription',
    ).error;
    expect(error).not.toContain('QQQQ');
  });

  it('redacts a secret that straddles the kept end of stderr (review M3)', () => {
    const key = `sk-ant-test-${'k'.repeat(60)}`;
    const stderr = `${'x'.repeat(100)} ${key} ${'y'.repeat(1_990)}`;
    const error = classifyClaudeRun(
      parseClaudeStream('', SKILL),
      { exitCode: 2, stderr },
      'subscription',
      [key],
    ).error;
    expect(error).not.toContain('kkkkkkkkkk');
  });

  it('distinguishes an invalid invocation, an empty stream, an overflow and malformed lines', () => {
    const empty = parseClaudeStream('', SKILL);
    expect(
      classifyClaudeRun(
        empty,
        { exitCode: 1, stderr: 'error: unknown option --bogus\n' },
        'subscription',
      ),
    ).toMatchObject({
      errorCode: 'cli-usage-error',
      error: 'Claude Code exited with code 1 before any output: error: unknown option --bogus',
    });
    expect(classifyClaudeRun(empty, { exitCode: null }, 'subscription').error).toBe(
      'Claude Code exited with code none before any output.',
    );
    expect(classifyClaudeRun(empty, OK, 'subscription')).toMatchObject({
      errorCode: 'output-parse-error',
      error: 'Claude Code output could not be read: Claude Code wrote no output.',
    });
    const secret = classifyClaudeRun(
      empty,
      { exitCode: 2, stderr: 'key sk-ant-test-0000000000000000fake rejected' },
      'subscription',
    ).error;
    expect(secret).not.toContain('sk-ant-test');

    const overflow = {
      ...parse('skill-invoked'),
      eventsOverflow: true,
      events: CLAUDE_STREAM_MAX_EVENTS,
    };
    expect(classifyClaudeRun(overflow, OK, 'subscription').error).toBe(
      'Claude Code output could not be read: the stream has too many events.',
    );
    const malformed = parseClaudeStream(`${fixture('skill-invoked')}garbage\n`, SKILL);
    expect(classifyClaudeRun(malformed, OK, 'subscription').error).toBe(
      'Claude Code output could not be read: 1 line(s) are not valid stream events. Last line: garbage',
    );
    const noResult = parseClaudeStream(
      fixture('skill-invoked').split('\n').slice(0, 3).join('\n'),
      SKILL,
    );
    expect(classifyClaudeRun(noResult, OK, 'subscription').error).toBe(
      'Claude Code output could not be read: the stream has no result line.',
    );
  });

  it('fails an error subtype without errors and a success that exited non-zero', () => {
    const base = parse('skill-invoked');
    expect(
      classifyClaudeRun(
        {
          ...base,
          result: { ...base.result!, subtype: 'error_during_execution', isError: true, text: null },
        },
        { exitCode: 1 },
        'subscription',
      ).error,
    ).toBe('Claude Code ended with error_during_execution.');
    expect(classifyClaudeRun(base, { exitCode: 3 }, 'subscription').error).toBe(
      'Claude Code exited with code 3.',
    );
    expect(classifyClaudeRun(base, { exitCode: null }, 'subscription').error).toBe(
      'Claude Code exited with code none.',
    );
    expect(classifyClaudeRun(parse('max-turns'), { exitCode: 1 }, 'subscription').error).toBe(
      'Claude Code ended with error_max_turns: Reached maximum number of turns (3)',
    );
  });
});

describe('claudeSkillActivation (FR-118-09)', () => {
  it.each([
    [
      'skill-invoked',
      SKILL.prompt,
      { loaded: true, invoked: true, invocations: 1, otherSkills: [] },
    ],
    [
      'skill-not-invoked',
      SKILL.prompt,
      { loaded: true, invoked: false, invocations: 0, otherSkills: [] },
    ],
    [
      'skill-not-loaded',
      SKILL.prompt,
      { loaded: false, invoked: false, invocations: 0, otherSkills: [] },
    ],
    [
      'skill-tool-missing',
      SKILL.prompt,
      { loaded: false, invoked: false, invocations: 0, otherSkills: [] },
    ],
    [
      'skill-call-denied',
      SKILL.prompt,
      { loaded: true, invoked: false, invocations: 0, otherSkills: [] },
    ],
    [
      'other-skill-denied',
      SKILL.prompt,
      { loaded: true, invoked: true, invocations: 1, otherSkills: ['deploy'] },
    ],
    [
      'slash-expanded',
      '/pdf summarise',
      { loaded: true, invoked: true, invocations: 1, otherSkills: [] },
    ],
    [
      'slash-forked',
      '/pdf summarise',
      { loaded: true, invoked: true, invocations: 1, otherSkills: [] },
    ],
    [
      'slash-not-expanded',
      '/pdf summarise',
      { loaded: true, invoked: false, invocations: 0, otherSkills: [] },
    ],
  ] as const)('%s with prompt %j', (name, prompt, expected) => {
    expect(claudeSkillActivation(parse(name, prompt))).toEqual(expected);
  });

  it('loads by the Skill tool alone when the init event lists no skills', () => {
    const parsed = parse('skill-invoked');
    const unlisted = {
      ...parsed,
      init: { ...parsed.init!, skillsListed: false, skillListed: false },
    };
    expect(claudeSkillActivation(unlisted)?.loaded).toBe(true);
  });

  it('is absent before the session start', () => {
    expect(claudeSkillActivation(parseClaudeStream('', SKILL))).toBeUndefined();
  });
});

describe('claudeRunMetadata (FR-118-04)', () => {
  it('separates the execution model from auxiliary models', () => {
    expect(claudeRunMetadata(parse('skill-invoked'), conditions())).toEqual({
      adapterVersion: '2.1.302',
      authMode: 'subscription',
      isolationProfile: 'user-profile',
      permissionProfile: 'edit-only',
      requestedModel: null,
      executionModel: 'claude-sonnet-4-5-20250929',
      reportedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'],
      auxiliaryModels: ['claude-haiku-4-5-20251001'],
      mismatchedMessageModels: [],
      flagsHash: 'f'.repeat(64),
    });
    expect(
      claudeRunMetadata(parse('auxiliary-only'), conditions({ authMode: 'api-key' })),
    ).toMatchObject({
      isolationProfile: 'isolated',
      auxiliaryModels: ['claude-3-5-haiku-20241022'],
    });
  });

  it('reports a main-conversation message and a later session start on another model', () => {
    expect(
      claudeRunMetadata(parse('model-mismatch'), conditions()).mismatchedMessageModels,
    ).toEqual(['claude-opus-4-1-20250805']);
    const parsed = parse('skill-invoked');
    const later = { ...parsed, init: { ...parsed.init!, laterModels: ['other'] } };
    expect(claudeRunMetadata(later, conditions()).mismatchedMessageModels).toEqual(['other']);
  });

  it('fails closed on a model set over its bound and has no mismatch without a session start', () => {
    const overflow = { ...parse('skill-invoked'), modelsOverflow: true };
    expect(claudeRunMetadata(overflow, conditions()).mismatchedMessageModels).toEqual([
      TOO_MANY_MODELS,
    ]);
    const noInit = { ...parse('skill-invoked'), init: null };
    expect(claudeRunMetadata(noInit, conditions())).toMatchObject({
      executionModel: null,
      mismatchedMessageModels: [],
    });
  });
});

describe('claudeRunOutcome', () => {
  it('assembles a completed run and drops the cost in subscription mode', () => {
    const outcome = claudeRunOutcome(parse('skill-invoked'), OK, conditions());
    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Claude Code finished after 3 turn(s).',
      error: null,
      warnings: ['ambient-user-config'],
      skillActivation: { loaded: true, invoked: true },
    });
    expect(outcome).not.toHaveProperty('errorCode');
    expect(outcome.usage).not.toHaveProperty('costUsd');
    expect(outcome.metadata?.executionModel).toBe('claude-sonnet-4-5-20250929');
  });

  it('keeps the estimated cost in api-key mode and omits skillActivation for instruction types', () => {
    const outcome = claudeRunOutcome(
      parse('api-key-success'),
      OK,
      conditions({ authMode: 'api-key', skill: false }),
    );
    expect(outcome.usage?.costUsd).toBe(0.0123);
    expect(outcome).not.toHaveProperty('skillActivation');
  });

  it('carries the error code, a cost-only usage and the dropped-trace note', () => {
    const failed = claudeRunOutcome(parse('rate-limited'), { exitCode: 1 }, conditions(), []);
    expect(failed).toMatchObject({ status: 'agent-error', errorCode: 'rate-limited' });
    expect(failed.summary).toBe(failed.error);
    expect(failed.usage).toMatchObject({ inputTokens: 1200 });

    const base = parse('skill-invoked');
    const costOnly = claudeRunOutcome(
      {
        ...base,
        usage: { costUsd: 1 },
        droppedTraceEvents: 2,
        result: { ...base.result!, numTurns: null },
      },
      OK,
      conditions(),
    );
    expect(costOnly.usage).toBeNull();
    expect(costOnly.summary).toBe('Claude Code finished.');
    expect(costOnly.trace.at(-1)).toEqual({
      type: 'message',
      text: '2 further trace event(s) were not kept.',
    });
    expect(claudeRunOutcome({ ...base, usage: null }, OK, conditions()).usage).toBeNull();
  });
});
