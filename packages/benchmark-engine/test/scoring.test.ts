import { describe, expect, it } from 'vitest';
import {
  aggregate,
  confidenceFor,
  displayStatus,
  scoreRun,
  summarize,
  type RunOutcome,
} from '../src/scoring';

const scoring = { passThreshold: 1, minDelta: 0.05, stabilityThreshold: 0.1 };

function run(
  variant: 'baseline' | 'candidate',
  score: number | null,
  overrides: Partial<RunOutcome> = {},
): RunOutcome {
  return {
    caseId: 'c',
    variant,
    repetition: 1,
    executionStatus: score === null ? 'agent-error' : 'completed',
    score,
    passed: score === null ? null : score >= 1,
    durationMs: 10,
    ...overrides,
  };
}

const options = {
  caseIds: ['c'],
  scoring,
  repetitions: 3,
  comparable: true,
  deterministicAgent: false,
};

describe('scoreRun', () => {
  it('computes the weighted score and honours required assertions', () => {
    expect(
      scoreRun(
        [
          { passed: true, score: 1, weight: 2, required: false },
          { passed: false, score: 0, weight: 2, required: true },
          { passed: false, score: 0, weight: 1, required: false },
          { passed: true, score: 1, weight: 1, required: false },
        ],
        0.4,
      ),
    ).toEqual({ score: 0.5, passed: false });
    expect(scoreRun([{ passed: true, score: 1, weight: 1, required: true }], 1)).toEqual({
      score: 1,
      passed: true,
    });
    expect(scoreRun([], 1)).toEqual({ score: 0, passed: false });
  });
});

describe('aggregate', () => {
  it('excludes failed executions from quality but counts them in the error rate', () => {
    expect(
      aggregate([run('baseline', 1), run('baseline', 0.5), run('baseline', null)]),
    ).toMatchObject({
      totalRuns: 3,
      validRuns: 2,
      meanScore: 0.75,
      stdDev: 0.25,
      passRate: 0.5,
      errorRate: 0.333333,
    });
  });
});

describe('summarize verdicts', () => {
  it('improved', () => {
    const s = summarize([run('baseline', 0.5), run('candidate', 1)], options);
    expect(s).toMatchObject({ verdict: 'improved', delta: 0.5, candidateOutcome: 'passed' });
  });

  it('regressed', () => {
    expect(summarize([run('baseline', 1), run('candidate', 0.5)], options).verdict).toBe(
      'regressed',
    );
  });

  it('unchanged within minDelta', () => {
    expect(summarize([run('baseline', 0.5), run('candidate', 0.52)], options).verdict).toBe(
      'unchanged',
    );
  });

  it('unstable when scores vary or pass rates are mixed', () => {
    const s = summarize(
      [run('baseline', 0.5), run('candidate', 1), run('candidate', 0.5, { repetition: 2 })],
      options,
    );
    expect(s.verdict).toBe('unstable');
    expect(s.confidence.level).toBe('medium');
  });

  it('error takes precedence when most runs did not complete', () => {
    expect(
      summarize(
        [run('baseline', 0.5), run('candidate', null), run('candidate', null), run('candidate', 1)],
        options,
      ).verdict,
    ).toBe('error');
    expect(summarize([run('baseline', null), run('candidate', 1)], options)).toMatchObject({
      verdict: 'error',
      candidateOutcome: null,
    });
  });

  it('not-comparable when the comparability check failed', () => {
    expect(
      summarize([run('baseline', 0.5), run('candidate', 1)], { ...options, comparable: false })
        .verdict,
    ).toBe('not-comparable');
  });
});

describe('confidence and display status', () => {
  it('derives confidence from repetitions and stability', () => {
    expect(confidenceFor(1, false).level).toBe('low');
    expect(confidenceFor(3, false).level).toBe('medium');
    expect(confidenceFor(10, false).level).toBe('high');
    expect(confidenceFor(10, true).level).toBe('medium');
  });

  it('maps verdicts to display statuses', () => {
    expect(displayStatus(null, null)).toBe('not-tested');
    expect(displayStatus('regressed', 'passed')).toBe('regression');
    expect(displayStatus('improved', 'passed')).toBe('passed');
    expect(displayStatus('unchanged', 'failed')).toBe('failed');
    expect(displayStatus('unstable', 'passed')).toBe('unstable');
  });
});
