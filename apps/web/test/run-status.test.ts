import { describe, expect, it } from 'vitest';
import { runDisplayStatus } from '../lib/run-status';

describe('runDisplayStatus', () => {
  it('treats a missing run as not tested', () => {
    expect(runDisplayStatus(null)).toBe('not-tested');
  });

  it('shows a run that failed to execute as an error, whatever its verdict', () => {
    expect(runDisplayStatus({ status: 'error', verdict: 'improved', summary: null })).toBe('error');
  });

  it.each(['running', 'cancelled', 'interrupted'])(
    'treats an unfinished (%s) run as not tested',
    (status) => {
      expect(runDisplayStatus({ status, verdict: 'improved', summary: null })).toBe('not-tested');
    },
  );

  it('uses the candidate outcome of a completed run', () => {
    const run = { status: 'completed', verdict: 'improved' };
    expect(runDisplayStatus({ ...run, summary: { candidateOutcome: 'passed' } })).toBe('passed');
    expect(runDisplayStatus({ ...run, summary: { candidateOutcome: 'failed' } })).toBe('failed');
  });

  it('maps verdicts that override the outcome', () => {
    const summary = { candidateOutcome: 'passed' };
    expect(runDisplayStatus({ status: 'completed', verdict: 'regressed', summary })).toBe(
      'regression',
    );
    expect(runDisplayStatus({ status: 'completed', verdict: 'unstable', summary })).toBe(
      'unstable',
    );
    expect(runDisplayStatus({ status: 'completed', verdict: null, summary })).toBe('not-tested');
  });

  it('treats a completed run without a summary as failed', () => {
    expect(runDisplayStatus({ status: 'completed', verdict: 'improved', summary: null })).toBe(
      'failed',
    );
  });
});
