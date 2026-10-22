import { describe, expect, it } from 'vitest';
import {
  agentProfileOf,
  agentRunMetadata,
  assertionDetailLines,
  assertionErrorOf,
  baselineLabel,
  baselineName,
  candidateLabel,
  hasAmbientConfig,
  invocationText,
  modelLabel,
  otherReportedModels,
  readSummary,
  runWarnings,
  traceCounts,
  usageText,
  type AgentProfile,
} from '../lib/run-detail';

const profile: AgentProfile = {
  authMode: 'subscription',
  isolationProfile: 'user-profile',
  permissionProfile: 'edit-only',
  flagsHash: 'f'.repeat(64),
  executionModel: 'claude-sonnet-4-6',
  hostId: 'host-1',
};
const isolated: AgentProfile = {
  ...profile,
  authMode: 'api-key',
  isolationProfile: 'isolated',
  hostId: undefined,
};

function metadataEvent(reportedModels: string[], extra: Record<string, unknown> = {}) {
  return {
    type: 'agent-metadata',
    metadata: {
      requestedModel: null,
      executionModel: 'claude-sonnet-4-6',
      reportedModels,
      flagsHash: 'x',
    },
    errorCode: null,
    warnings: [],
    ...extra,
  };
}

describe('readSummary and agentProfileOf', () => {
  it('reads the fields the results views use and ignores the rest', () => {
    const summary = {
      delta: 0.25,
      verdict: 'improved',
      candidateOutcome: 'passed',
      candidate: { meanScore: 0.75, validRuns: 2 },
      confidence: { level: 'low', reason: 'r' },
      scoring: { minDelta: 0.05, passThreshold: 1 },
      environment: { kind: 'local-process', agentProfile: profile },
      skillInvocation: {
        baseline: { invoked: 0, runs: 2 },
        candidate: { invoked: 2, runs: 2 },
      },
      cases: [],
    };
    expect(readSummary(summary)).toMatchObject({
      delta: 0.25,
      candidate: { meanScore: 0.75 },
      scoring: { minDelta: 0.05 },
    });
    expect(agentProfileOf(summary)).toEqual(profile);
  });

  it.each([null, undefined, 'text', { delta: 'big' }, { environment: { agentProfile: { x: 1 } } }])(
    'reads an unreadable summary (%j) as empty: nothing is invented',
    (summary) => {
      expect(readSummary(summary)).toEqual({});
      expect(agentProfileOf(summary)).toBeNull();
    },
  );

  it('has no profile for a run whose adapter reported none (mock agent)', () => {
    expect(agentProfileOf({ environment: { kind: 'local-process' } })).toBeNull();
  });
});

describe('baseline and candidate labels (SPEC-118 FR-118-52)', () => {
  it('names baseline kind none and an A/B baseline version', () => {
    expect(baselineName(null)).toBe('no artifact');
    expect(baselineName({ version: 3 })).toBe('v3');
    expect(baselineLabel(null)).toBe('Baseline (no artifact)');
    expect(baselineLabel({ version: 3 })).toBe('Baseline (v3)');
    expect(candidateLabel({ version: 4 })).toBe('Candidate (v4)');
  });
});

describe('modelLabel', () => {
  it('shows the requested model, and the execution model when the adapter reported one', () => {
    expect(modelLabel(null, null)).toBe('n/a');
    expect(modelLabel({ provider: 'mock', model: 'm' }, null)).toBe('mock/m');
    expect(modelLabel(null, profile)).toBe('agent default → claude-sonnet-4-6');
    expect(modelLabel({ provider: 'anthropic', model: 'sonnet' }, profile)).toBe(
      'anthropic/sonnet → claude-sonnet-4-6',
    );
  });
});

describe('runWarnings and hasAmbientConfig', () => {
  it('explains known codes and keeps free text', () => {
    expect(
      runWarnings(
        [
          'ambient-user-config: 4/4 agent runs',
          'artifact-not-invoked',
          'Deterministic agent: repetitions confirm reproducibility.',
          'some-new-code: 1/4 agent runs',
        ],
        null,
      ),
    ).toEqual([
      {
        code: 'ambient-user-config',
        text: 'ambient-user-config: 4/4 agent runs',
        explanation: expect.stringContaining('May include user-level instructions'),
      },
      {
        code: 'artifact-not-invoked',
        text: 'artifact-not-invoked',
        explanation: expect.stringContaining('did not invoke'),
      },
      {
        code: null,
        text: 'Deterministic agent: repetitions confirm reproducibility.',
        explanation: null,
      },
      { code: 'some-new-code', text: 'some-new-code: 1/4 agent runs', explanation: null },
    ]);
  });

  it('never explains a code from the object prototype', () => {
    expect(runWarnings(['constructor: x'], null)).toEqual([
      { code: 'constructor', text: 'constructor: x', explanation: null },
    ]);
  });

  it('always shows the ambient-configuration warning for the user-profile isolation', () => {
    const [first] = runWarnings([], profile);
    expect(first).toMatchObject({ code: 'ambient-user-config' });
    expect(first?.explanation).toContain('May include user-level instructions');
    expect(runWarnings(['ambient-user-config: 2/2 agent runs'], profile)).toHaveLength(1);
    expect(hasAmbientConfig([], profile)).toBe(true);
    expect(hasAmbientConfig(['ambient-user-config: 2/2 agent runs'], null)).toBe(true);
    expect(hasAmbientConfig([], isolated)).toBe(false);
    expect(hasAmbientConfig(['unpinned-model'], null)).toBe(false);
  });
});

describe('agent-run metadata from the trace (SPEC-118 §8.1)', () => {
  it('finds the agent-metadata event and its skill activation', () => {
    const activation = { loaded: true, invoked: true, invocations: 1, otherSkills: [] };
    const trace = [
      { type: 'stage', stage: 'prepare' },
      metadataEvent(['claude-sonnet-4-6'], { skillActivation: activation }),
    ];
    expect(agentRunMetadata(trace)).toMatchObject({
      metadata: { executionModel: 'claude-sonnet-4-6' },
      skillActivation: activation,
    });
  });

  it.each([null, 'trace', [{ type: 'message', text: 'hi' }], [{ type: 'agent-metadata' }]])(
    'returns null without a readable event (%j)',
    (trace) => {
      expect(agentRunMetadata(trace)).toBeNull();
    },
  );

  it('lists the other reported models over all agent runs, sorted', () => {
    const traces = [
      [metadataEvent(['claude-sonnet-4-6', 'claude-haiku-4-5'])],
      [metadataEvent(['claude-sonnet-4-6', 'claude-a'])],
      [{ type: 'message' }],
    ];
    expect(otherReportedModels(traces, profile)).toEqual(['claude-a', 'claude-haiku-4-5']);
    // Agent runs that disagreed: the profile joins the execution models with " | ".
    expect(
      otherReportedModels(traces, { ...profile, executionModel: 'claude-sonnet-4-6 | claude-a' }),
    ).toEqual(['claude-haiku-4-5']);
    expect(otherReportedModels(traces, null)).toEqual([
      'claude-a',
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
    ]);
  });
});

describe('invocationText (SPEC-118 FR-118-09)', () => {
  it('shows the rate per variant when recorded', () => {
    const summary = {
      skillInvocation: { baseline: { invoked: 0, runs: 2 }, candidate: { invoked: 1, runs: 2 } },
    };
    expect(invocationText(summary, 'candidate')).toBe('Skill invoked in 1/2 runs');
    expect(invocationText(summary, 'baseline')).toBe('Skill invoked in 0/2 runs');
    expect(invocationText({}, 'candidate')).toBeNull();
  });
});

describe('usageText (SPEC-118 FR-118-52)', () => {
  it('shows tokens and cost exactly as reported', () => {
    expect(usageText({ inputTokens: 1234, outputTokens: 56, costUsd: 0.0123 }, isolated)).toEqual({
      tokens: '1,234 in / 56 out',
      cost: '$0.0123 (estimated)',
    });
    expect(usageText({ outputTokens: 5 }, null)).toEqual({
      tokens: 'not reported in / 5 out',
      cost: 'not reported',
    });
  });

  it('never invents a value: missing usage reads "not reported"', () => {
    expect(usageText(null, null)).toEqual({ tokens: 'not reported', cost: 'not reported' });
    expect(usageText({ inputTokens: 'x' }, null)).toEqual({
      tokens: 'not reported',
      cost: 'not reported',
    });
  });

  it('labels cost in Local Subscription Mode as not applicable', () => {
    expect(usageText({ inputTokens: 1, costUsd: 0.5 }, profile).cost).toBe('n/a (subscription)');
  });
});

describe('traceCounts', () => {
  it('counts tool calls, permission denials and retries', () => {
    const trace = [
      { type: 'tool-call', tool: 'Edit', callId: '1' },
      { type: 'tool-result', callId: '1', ok: true },
      { type: 'tool-call', tool: 'Bash', callId: '2' },
      { type: 'permission-denied', tool: 'Bash' },
      { type: 'retry', attempt: 1, category: 'rate_limit' },
      null,
      'text',
    ];
    expect(traceCounts(trace)).toEqual({ toolCalls: 2, permissionDenials: 1, retries: 1 });
    expect(traceCounts('not a trace')).toEqual({ toolCalls: 0, permissionDenials: 0, retries: 0 });
  });
});

describe('assertionDetailLines (SPEC-118 FR-118-40…46)', () => {
  it('shows an evaluation error with its patterns, for any type', () => {
    const details = {
      error: { code: 'pattern-timeout', message: 'Pattern evaluation exceeded 2000 ms' },
      patterns: ['/(a+)+$/', '/x/i'],
    };
    expect(assertionDetailLines('required-phrases', details)).toEqual([
      { label: 'Evaluation error', value: 'pattern-timeout: Pattern evaluation exceeded 2000 ms' },
      { label: 'Patterns', value: '/(a+)+$/, /x/i' },
    ]);
    expect(
      assertionDetailLines('file-contains', { error: details.error }).map((l) => l.label),
    ).toEqual(['Evaluation error']);
  });

  it('shows a glob that matched no file, several files, or more than are listed', () => {
    expect(
      assertionDetailLines('markdown-sections', { file: '**/*.md', matches: [], matchCount: 0 }),
    ).toEqual([
      { label: 'File pattern', value: '**/*.md' },
      { label: 'Matches (0)', value: '—' },
    ]);
    expect(
      assertionDetailLines('required-phrases', {
        file: '*.md',
        matches: ['a.md', 'b.md'],
        matchCount: 25,
      })[1],
    ).toEqual({ label: 'Matches (25)', value: 'a.md, b.md … 23 more' });
    expect(
      assertionDetailLines('required-phrases', {
        file: '*.md',
        matches: ['a.md', 'b.md'],
        matchCount: 2,
      })[1],
    ).toEqual({ label: 'Matches (2)', value: 'a.md, b.md' });
  });

  it('shows a target file that could not be read', () => {
    expect(
      assertionDetailLines('markdown-table-value', { file: 'out.md', target: 'out.md' }),
    ).toEqual([
      { label: 'File', value: 'out.md' },
      { label: 'Resolved to', value: 'out.md' },
    ]);
  });

  it('shows found, missing and misordered headings', () => {
    expect(
      assertionDetailLines('markdown-sections', {
        file: 'plan.md',
        found: ['Risks', 'Estimate'],
        missing: [],
        misordered: ['Risks'],
      }),
    ).toEqual([
      { label: 'File', value: 'plan.md' },
      { label: 'Found', value: 'Risks, Estimate' },
      { label: 'Missing', value: '—' },
      { label: 'Out of order', value: 'Risks' },
    ]);
    expect(
      assertionDetailLines('markdown-sections', {
        file: 'plan.md',
        found: [],
        missing: ['Risks'],
        misordered: [],
      }).map((l) => l.label),
    ).toEqual(['File', 'Found', 'Missing']);
  });

  it('shows found and missing phrases', () => {
    expect(
      assertionDetailLines('required-phrases', {
        file: 'plan.md',
        found: ['QA'],
        missing: ['/PM\\b/i'],
      }),
    ).toEqual([
      { label: 'File', value: 'plan.md' },
      { label: 'Found', value: 'QA' },
      { label: 'Missing', value: '/PM\\b/i' },
    ]);
  });

  it('shows the checked table cell, with or without a number', () => {
    const base = { file: 'plan.md', row: '/Backend/i', column: 'Hours' };
    expect(
      assertionDetailLines('markdown-table-value', {
        ...base,
        tableIndex: 2,
        rowText: '| Backend API | 24 |',
        cell: '24',
        value: 24,
      }),
    ).toEqual([
      { label: 'File', value: 'plan.md' },
      { label: 'Row', value: '/Backend/i' },
      { label: 'Column', value: 'Hours' },
      { label: 'Table', value: '#2' },
      { label: 'Row text', value: '| Backend API | 24 |' },
      { label: 'Cell', value: '24' },
      { label: 'Value', value: '24' },
    ]);
    expect(
      assertionDetailLines('markdown-table-value', { ...base, cell: 'n/a', value: null }).at(-1),
    ).toEqual({ label: 'Value', value: 'no number' });
    expect(assertionDetailLines('markdown-table-value', base)).toHaveLength(3);
  });

  it('tells an evaluation error apart from a failed check', () => {
    const error = { code: 'pattern-timeout', message: 'timed out' };
    expect(assertionErrorOf({ error, patterns: [] })).toEqual(error);
    expect(assertionErrorOf({ file: 'x', found: [], missing: ['a'] })).toBeNull();
    expect(assertionErrorOf(null)).toBeNull();
  });

  it('returns nothing for other types and unreadable details', () => {
    expect(assertionDetailLines('command', { command: ['npm', 'test'], exitCode: 0 })).toEqual([]);
    expect(assertionDetailLines('markdown-sections', { file: 'x' })).toEqual([]);
    expect(assertionDetailLines('required-phrases', null)).toEqual([]);
    expect(assertionDetailLines('markdown-table-value', { file: 1 })).toEqual([]);
  });
});
