import { describe, expect, it } from 'vitest';
import {
  compareHref,
  comparePaths,
  parseCompareQuery,
  selectCompareRuns,
  type CompareAgentRun,
  type CompareQuery,
} from '../lib/compare-files';

const run = (
  id: string,
  caseId: string,
  variant: CompareAgentRun['variant'],
  repetition: number,
): CompareAgentRun => ({ id, caseId, variant, repetition });

// Stored order is by insertion, not by variant: the selection must not depend on it.
const runs = [
  run('c2', 'case-a', 'candidate', 2),
  run('b2', 'case-a', 'baseline', 2),
  run('c1', 'case-a', 'candidate', 1),
  run('b1', 'case-a', 'baseline', 1),
  run('x1', 'case-b', 'baseline', 1),
];

const query = (overrides: Partial<CompareQuery> = {}): CompareQuery => ({
  caseId: null,
  left: null,
  right: null,
  path: null,
  ...overrides,
});

describe('parseCompareQuery (§10)', () => {
  it('reads one non-empty value per parameter and treats empty or repeated ones as absent', () => {
    expect(parseCompareQuery({ case: 'c', left: 'l', right: 'r', path: 'src/a.js' })).toEqual({
      caseId: 'c',
      left: 'l',
      right: 'r',
      path: 'src/a.js',
    });
    expect(parseCompareQuery({ case: '', left: ['a', 'b'] })).toEqual(query());
  });
});

describe('selectCompareRuns (FR-123-30)', () => {
  it('defaults to the first case, baseline repetition 1 on the left and candidate repetition 1 on the right', () => {
    const selection = selectCompareRuns(runs, query());
    expect(selection).toMatchObject({ kind: 'runs', caseId: 'case-a' });
    if (selection.kind !== 'runs') throw new Error('expected runs');
    expect(selection.left.id).toBe('b1');
    expect(selection.right.id).toBe('c1');
    expect(selection.caseRuns.map((r) => r.id)).toEqual(['b1', 'b2', 'c1', 'c2']);
  });

  it('takes the requested runs of the requested case', () => {
    const selection = selectCompareRuns(runs, query({ caseId: 'case-a', left: 'c2', right: 'b2' }));
    expect(selection).toMatchObject({ kind: 'runs', left: { id: 'c2' }, right: { id: 'b2' } });
  });

  it('allows the same agent run on both sides', () => {
    const selection = selectCompareRuns(runs, query({ caseId: 'case-a', left: 'b1', right: 'b1' }));
    expect(selection).toMatchObject({ kind: 'runs', left: { id: 'b1' }, right: { id: 'b1' } });
  });

  it('falls back to the first agent run of the case when a variant has none', () => {
    const selection = selectCompareRuns(runs, query({ caseId: 'case-b' }));
    expect(selection).toMatchObject({ kind: 'runs', left: { id: 'x1' }, right: { id: 'x1' } });
  });

  it('is not found for an unknown case, an unknown run or a run of another case', () => {
    expect(selectCompareRuns(runs, query({ caseId: 'nope' }))).toEqual({ kind: 'not-found' });
    expect(selectCompareRuns(runs, query({ left: 'nope' }))).toEqual({ kind: 'not-found' });
    expect(selectCompareRuns(runs, query({ caseId: 'case-a', right: 'x1' }))).toEqual({
      kind: 'not-found',
    });
  });

  it('has nothing to compare without agent runs, and not found when runs were requested', () => {
    expect(selectCompareRuns([], query())).toEqual({ kind: 'none' });
    expect(selectCompareRuns([], query({ caseId: 'case-a' }))).toEqual({ kind: 'not-found' });
    expect(selectCompareRuns([], query({ left: 'b1' }))).toEqual({ kind: 'not-found' });
    expect(selectCompareRuns([], query({ right: 'c1' }))).toEqual({ kind: 'not-found' });
  });
});

describe('comparePaths (FR-123-30)', () => {
  it('lists the union by path and marks paths present on one side only', () => {
    const left = [{ path: 'b.js' }, { path: 'a.js' }];
    const right = [{ path: 'c.js' }, { path: 'b.js' }, { path: 'B.js' }];
    expect(comparePaths(left, right)).toEqual([
      { path: 'B.js', left: null, right: { path: 'B.js' }, onlyIn: 'right' },
      { path: 'a.js', left: { path: 'a.js' }, right: null, onlyIn: 'left' },
      { path: 'b.js', left: { path: 'b.js' }, right: { path: 'b.js' }, onlyIn: null },
      { path: 'c.js', left: null, right: { path: 'c.js' }, onlyIn: 'right' },
    ]);
    expect(comparePaths([], [])).toEqual([]);
  });
});

describe('compareHref', () => {
  it('encodes the run id and every query value, with or without a path', () => {
    expect(compareHref('run 1', { caseId: 'c&d', left: 'l', right: 'r' })).toBe(
      '/results/run%201/compare?case=c%26d&left=l&right=r',
    );
    expect(compareHref('r', { caseId: 'c', left: 'l', right: 'r', path: 'src/a b.js' })).toBe(
      '/results/r/compare?case=c&left=l&right=r&path=src%2Fa+b.js',
    );
  });
});
