import { describe, expect, it } from 'vitest';
import type { PreparedSuite } from '@directivebench/benchmark-engine';
import type { ArtifactBundle } from '@directivebench/core';
import type { BenchmarkRunDetail } from '@directivebench/database';
import type { Resolved, RunOptions } from '../src/benchmark-plan';
import {
  EXIT_CANCELLED,
  exitCodeFor,
  isInteractive,
  planText,
  reportText,
  runReport,
  type RunReport,
} from '../src/benchmark-run';
import { ExitCode } from '../src/runtime';

const candidate = {
  artifactId: 'art',
  versionId: 'v',
  slug: 'pdf',
  name: 'pdf',
  type: 'instruction',
  format: 'claude-md',
  contentHash: 'h',
  files: [],
} satisfies ArtifactBundle;

const options: RunOptions = {
  suitePath: 's',
  artifact: 'pdf',
  version: undefined,
  baselineVersion: null,
  authMode: 'api-key',
  maxBudgetUsd: undefined,
  approveCommands: false,
  yes: true,
  json: false,
};

describe('planText (FR-118-31)', () => {
  it('names a pinned model and an unknown agent version', () => {
    const prepared = {
      contentHash: 'c'.repeat(64),
      definition: {
        id: 'suite',
        name: 'Suite',
        cases: [{ id: 'a', setup: [], assertions: [] }],
        execution: { model: { provider: 'anthropic', model: 'claude-x' }, repetitions: 2 },
      },
    } as unknown as PreparedSuite;
    const resolved = {
      ref: { version: { version: 4 } },
      candidate,
      baseline: null,
    } as unknown as Resolved;
    const lines = planText({
      prepared,
      resolved,
      options,
      agentVersion: null,
      storedApproved: false,
      runsCommands: false,
    });
    expect(lines).toContain('Agent:      Claude Code (version unknown)');
    expect(lines).toContain('Model:      anthropic/claude-x');
    expect(lines).toContain('Agent runs: 4 (1 case(s) × 2 repetition(s) × 2 variants)');
    expect(lines.join('\n')).not.toContain('disable-model-invocation');
  });
});

function detail(overrides: {
  run?: Partial<BenchmarkRunDetail['run']>;
  baseline?: number | null;
  usage?: Record<string, number> | null;
}): BenchmarkRunDetail {
  return {
    run: {
      id: 'run_1',
      status: 'error',
      verdict: 'error',
      summary: null,
      warnings: [],
      error: 'Stopped',
      ...overrides.run,
    },
    suite: { slug: 'suite', name: 'Suite' },
    suiteVersion: { version: 1 },
    artifact: { slug: 'pdf' },
    artifactVersion: { version: 2 },
    baselineArtifactVersion:
      overrides.baseline == null
        ? { id: null, version: null, contentHash: null }
        : { id: 'b', version: overrides.baseline, contentHash: 'h' },
    agentRuns: [{ usage: overrides.usage ?? null }, { usage: { inputTokens: 5, note: 'x' } }],
  } as unknown as BenchmarkRunDetail;
}

describe('runReport and reportText (FR-118-37)', () => {
  it('reports a run without a summary from its status', () => {
    const report = runReport(detail({}), 'api-key');
    expect(report).toMatchObject({
      displayStatus: 'error',
      baseline: { kind: 'none' },
      baselineScore: null,
      delta: null,
      confidence: null,
      skillInvocation: null,
      executionModel: null,
      usage: { inputTokens: 5, outputTokens: null, costUsd: null, cost: 'not reported' },
    });
    expect(
      runReport(detail({ run: { status: 'cancelled', verdict: null } }), 'api-key'),
    ).toMatchObject({ displayStatus: 'cancelled' });
    const text = reportText(report);
    expect(text).toContain('Result:     error (verdict: error)');
    expect(text).toContain('Baseline (no artifact):  score —');
    expect(text).toContain('Delta:      —');
    expect(text).toContain('Model:      not reported');
    expect(text).toContain('Tokens:     input 5, output not reported');
    expect(text).toContain('Cost:       not reported');
    expect(text).toContain('Error:      Stopped');
  });

  it('reports an A/B run with a negative delta and an estimated cost', () => {
    const summary = {
      displayStatus: 'regression',
      baseline: { meanScore: 1 },
      candidate: { meanScore: 0.5 },
      delta: -0.5,
      confidence: { level: 'low' },
      environment: {},
    };
    const report = runReport(
      detail({
        run: { status: 'completed', verdict: 'regressed', summary, error: null, warnings: ['w'] },
        baseline: 3,
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.25 },
      }),
      'api-key',
    );
    expect(report.usage).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      costUsd: 0.25,
      cost: 'estimated',
    });
    const text = reportText(report);
    expect(text).toContain('Baseline (v3):  score 100.0%');
    expect(text).toContain('Delta:      -50.0 points');
    expect(text).toContain('Cost:       $0.2500 (estimated)');
    expect(text).toContain('Warning:    w');
    expect(text).not.toContain('Skill invoked');
  });
});

describe('exitCodeFor (FR-118-38, AC-11)', () => {
  const report = (status: string, displayStatus: string) =>
    ({ status, displayStatus }) as RunReport;
  it.each([
    ['passed', ExitCode.Ok],
    ['failed', ExitCode.CheckFailed],
    ['regression', ExitCode.CheckFailed],
    ['unstable', ExitCode.CheckFailed],
    ['error', ExitCode.CheckFailed],
    ['not-comparable', ExitCode.CheckFailed],
  ])('%s → %i', (displayStatus, code) => {
    expect(exitCodeFor(report('completed', displayStatus))).toBe(code);
  });

  it('a cancelled run exits 130', () => {
    expect(exitCodeFor(report('cancelled', 'cancelled'))).toBe(EXIT_CANCELLED);
  });
});

describe('isInteractive (FR-118-32)', () => {
  it('needs both stdin and stdout to be terminals', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: true }, {})).toBe(false);
    expect(isInteractive({}, { isTTY: true })).toBe(false);
  });
});
