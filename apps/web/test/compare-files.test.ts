import { describe, expect, it } from 'vitest';
import {
  compareHref,
  comparePaths,
  compareRunOptionLabel,
  compareSideNotice,
  missingPathNotice,
  onlyInSide,
  pairBadge,
  selectComparePath,
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
  it('encodes the run id and every query value, leaving out the defaults', () => {
    expect(compareHref('r', { caseId: 'c' })).toBe('/results/r/compare?case=c');
    expect(compareHref('run 1', { caseId: 'c&d', left: 'l', right: 'r' })).toBe(
      '/results/run%201/compare?case=c%26d&left=l&right=r',
    );
    expect(compareHref('r', { caseId: 'c', left: 'l', right: 'r', path: 'src/a b.js' })).toBe(
      '/results/r/compare?case=c&left=l&right=r&path=src%2Fa+b.js',
    );
  });
});

describe('pairBadge (D43)', () => {
  const sha = (c: string) => c.repeat(64);
  it('says Identical for the same change and original bytes, Differs otherwise, never green', () => {
    expect(
      pairBadge({ change: 'modified', sha256: sha('a') }, { change: 'modified', sha256: sha('a') }),
    ).toEqual({
      label: 'Identical',
      variant: 'outline',
    });
    expect(
      pairBadge({ change: 'deleted', sha256: null }, { change: 'deleted', sha256: null }).label,
    ).toBe('Identical');
    expect(
      pairBadge({ change: 'modified', sha256: sha('a') }, { change: 'modified', sha256: sha('b') }),
    ).toEqual({
      label: 'Differs',
      variant: 'outline',
    });
    // Same bytes, but one run added the file and the other modified it.
    expect(
      pairBadge({ change: 'added', sha256: sha('a') }, { change: 'modified', sha256: sha('a') })
        .label,
    ).toBe('Differs');
  });
});

describe('selectComparePath (FR-123-30, D38)', () => {
  it('shows the requested path, the first path by default, and the first path for a missing one', () => {
    expect(selectComparePath(['a', 'b'], 'b')).toEqual({ path: 'b', missing: null });
    expect(selectComparePath(['a', 'b'], null)).toEqual({ path: 'a', missing: null });
    expect(selectComparePath(['a', 'b'], 'zz')).toEqual({ path: 'a', missing: 'zz' });
    expect(selectComparePath([], null)).toEqual({ path: null, missing: null });
    expect(selectComparePath([], 'zz')).toEqual({ path: null, missing: 'zz' });
    expect(missingPathNotice('src/x.js')).toBe(
      'src/x.js is not in either agent run, so the first file is shown.',
    );
  });
});

describe('compareSideNotice (D41)', () => {
  it('names the side and says why it lists no file', () => {
    const kept = { outputFilesKept: true, outputFilesReason: null };
    expect(compareSideNotice('Left', kept, 2)).toBeNull();
    expect(compareSideNotice('Left', kept, 0)).toBe('Left: The agent did not change any file.');
    expect(compareSideNotice('Right', { outputFilesKept: false, outputFilesReason: null }, 0)).toBe(
      'Right: Output files were not kept for this agent run.',
    );
    expect(
      compareSideNotice('Right', { outputFilesKept: false, outputFilesReason: 'it timed out.' }, 0),
    ).toBe('Right: Output files were not kept: it timed out.');
  });
});

describe('compareRunOptionLabel (D39)', () => {
  it('adds the D23 status to the agent-run label', () => {
    expect(
      compareRunOptionLabel('Baseline (v2)', {
        executionStatus: 'completed',
        passed: true,
        repetition: 1,
      }),
    ).toBe('Baseline (v2), repetition 1 (passed)');
    expect(
      compareRunOptionLabel('Candidate (v3)', {
        executionStatus: 'timeout',
        passed: null,
        repetition: 2,
      }),
    ).toBe('Candidate (v3), repetition 2 (timeout)');
  });
});

describe('onlyInSide (browser QA finding 1)', () => {
  it('names the side only when the other agent run kept its files', () => {
    const both = { left: true, right: true };
    expect(onlyInSide({ onlyIn: 'left' }, both)).toBe('left');
    expect(onlyInSide({ onlyIn: 'right' }, both)).toBe('right');
    expect(onlyInSide({ onlyIn: null }, both)).toBeNull();
    expect(onlyInSide({ onlyIn: 'left' }, { left: true, right: false })).toBeNull();
    expect(onlyInSide({ onlyIn: 'right' }, { left: false, right: true })).toBeNull();
  });
});
