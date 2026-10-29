import { describe, expect, it } from 'vitest';
import {
  REDACTION_MARKER,
  replaceTextRanges,
  SECRET_PATTERNS,
  type TextRange,
} from '@directivebench/core';
import { ClaudeCodeAdapter, MockAgentAdapter, type AgentAdapter } from '../src';

const API_KEY = 'sk-ant-api03-output-file-key-0123456789';
const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const BODY = '\nQQQQ-key-body-QQQQ\n';

const apiKeyAdapter = () =>
  new ClaudeCodeAdapter({ authMode: 'api-key' }, { ANTHROPIC_API_KEY: API_KEY, PATH: '' });

function covered(text: string, ranges: readonly TextRange[]): string[] {
  return ranges.map((r) => text.slice(r.start, r.end));
}

describe('findOutputSecrets (SPEC-123 FR-123-60)', () => {
  it('mock agent: core rules only, no known secret', () => {
    const mock = new MockAgentAdapter();
    const text = `token ghp_${'a'.repeat(24)} and ${BEGIN}${BODY}`;
    expect(covered(text, mock.findOutputSecrets(text, { textEnd: 'file-end' }))).toEqual([
      `ghp_${'a'.repeat(24)}`,
      BODY,
    ]);
    // A custom secret value is unknown to the mock.
    expect(mock.findOutputSecrets('my-custom-value-123', { textEnd: 'cut' })).toEqual([]);
  });

  it('Claude Code in API Key Mode: the API key, its JSON-escaped forms and the prefix rule', () => {
    const quoted = 'key"with-quote-123456';
    const adapter = new ClaudeCodeAdapter(
      { authMode: 'api-key' },
      { ANTHROPIC_API_KEY: quoted, PATH: '' },
    );
    const text = `raw ${quoted} json ${JSON.stringify(quoted)}`;
    expect(covered(text, adapter.findOutputSecrets(text, { textEnd: 'file-end' }))).toEqual([
      quoted,
      'key\\"with-quote-123456',
    ]);
    const cut = `ends with ${quoted.slice(0, 6)}`;
    expect(covered(cut, adapter.findOutputSecrets(cut, { textEnd: 'cut' }))).toEqual([
      quoted.slice(0, 6),
    ]);
    expect(adapter.findOutputSecrets(cut, { textEnd: 'file-end' })).toEqual([]);
  });

  it('Claude Code in subscription mode knows no key, even with one in the environment', () => {
    const adapter = new ClaudeCodeAdapter({}, { ANTHROPIC_API_KEY: 'custom-value-0123456789' });
    expect(adapter.findOutputSecrets('custom-value-0123456789', { textEnd: 'file-end' })).toEqual(
      [],
    );
  });

  it('Claude Code in API Key Mode without a key in the environment: core rules only', () => {
    const adapter = new ClaudeCodeAdapter({ authMode: 'api-key' }, {});
    const text = `x ${BEGIN}${BODY}${END}`;
    expect(covered(text, adapter.findOutputSecrets(text, { textEnd: 'file-end' }))).toEqual([BODY]);
  });

  describe('trace redaction corpus: replacing the ranges leaves no secret', () => {
    const corpus = [
      'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'openai: sk-proj-abcdefghijklmnopqrstuvwxyz',
      'gh: ghp_abcdefghijklmnopqrstuvwxyz0123',
      'pat: github_pat_abcdefghijklmnopqrstuvwxyz',
      'gitlab: glpat-abcdefghijklmnopqrstu',
      'slack: xoxb-1234567890-abcdef',
      'aws: AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abc.def.ghi',
      `api key ${API_KEY} in the middle`,
      `escaped ${JSON.stringify(API_KEY)}`,
      `a ${BEGIN}${BODY}${END} b`,
      `a ${BEGIN}${BODY}`,
      `${BODY}${END} b`,
      `${END} kept ${BEGIN}${BODY}`,
      `${BEGIN}${BODY}${END}${BODY}${END}`,
      `x${BEGIN}${BODY}${BODY}${END}zzzzzzzzzz`,
    ];
    const adapters: [string, AgentAdapter][] = [
      ['mock', new MockAgentAdapter()],
      ['claude-code', apiKeyAdapter()],
    ];

    for (const [name, adapter] of adapters) {
      it(name, () => {
        for (const text of corpus) {
          const redacted = replaceTextRanges(
            text,
            adapter.findOutputSecrets(text, { textEnd: 'file-end' }),
          );
          expect(redacted).not.toContain('QQQQ');
          // The marker itself is the token of `Authorization: Bearer [REDACTED]`.
          const rest = redacted.replaceAll(REDACTION_MARKER, '');
          for (const pattern of SECRET_PATTERNS) {
            expect(rest).not.toMatch(new RegExp(pattern.source, pattern.flags.replace('g', '')));
          }
          if (name === 'claude-code') expect(redacted).not.toContain(API_KEY);
        }
      });
    }
  });
});
