import { describe, expect, it } from 'vitest';
import {
  diffLines,
  diffSummary,
  FILE_DIFF_MAX_EDIT_LINES,
  type DiffRow,
  type LineDiff,
} from '../lib/line-diff';

function aligned(diff: LineDiff): Extract<LineDiff, { kind: 'aligned' }> {
  if (diff.kind !== 'aligned') throw new Error('expected an aligned diff');
  return diff;
}

const sides = (rows: DiffRow[]) => ({
  left: rows.flatMap((row) => (row.left ? [row.left.text] : [])),
  right: rows.flatMap((row) => (row.right ? [row.right.text] : [])),
});

// Reference: the minimal number of edits is n + m - 2·LCS, from the textbook dynamic program.
function minimalEdits(a: string[], b: string[]): number {
  const lcs = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return a.length + b.length - 2 * lcs[0]![0]!;
}

// A small deterministic generator (no Math.random: coverage and failures stay reproducible).
function lines(seed: number, length: number, alphabet: number): string[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return `line ${state % alphabet}`;
  });
}

describe('diffLines', () => {
  it('reports identical files as aligned rows with no change', () => {
    const diff = aligned(diffLines(['a', 'b'], ['a', 'b']));
    expect(diff).toMatchObject({ removed: 0, added: 0 });
    expect(diff.rows).toEqual([
      {
        left: { line: 1, text: 'a', change: 'same' },
        right: { line: 1, text: 'a', change: 'same' },
      },
      {
        left: { line: 2, text: 'b', change: 'same' },
        right: { line: 2, text: 'b', change: 'same' },
      },
    ]);
  });

  it('handles two empty files', () => {
    expect(diffLines([], [])).toEqual({ kind: 'aligned', rows: [], removed: 0, added: 0 });
  });

  it('marks every line added when the left file is empty', () => {
    const diff = aligned(diffLines([], ['x', 'y']));
    expect(diff).toMatchObject({ removed: 0, added: 2 });
    expect(diff.rows.map((row) => [row.left, row.right?.change])).toEqual([
      [null, 'added'],
      [null, 'added'],
    ]);
  });

  it('marks every line removed when the right file is empty', () => {
    const diff = aligned(diffLines(['x'], []));
    expect(diff).toMatchObject({ removed: 1, added: 0 });
    expect(diff.rows).toEqual([{ left: { line: 1, text: 'x', change: 'removed' }, right: null }]);
  });

  it('pairs a changed line with its replacement on one row', () => {
    const diff = aligned(diffLines(['a', 'old', 'c'], ['a', 'new', 'c']));
    expect(diff).toMatchObject({ removed: 1, added: 1 });
    expect(diff.rows[1]).toEqual({
      left: { line: 2, text: 'old', change: 'removed' },
      right: { line: 2, text: 'new', change: 'added' },
    });
  });

  it('continues the longer side of a change against empty cells', () => {
    const diff = aligned(diffLines(['a', 'b', 'z'], ['a', 'x', 'y', 'w', 'z']));
    expect(diff.rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'x'],
      [null, 'y'],
      [null, 'w'],
      ['z', 'z'],
    ]);
    expect(diff.rows.at(-1)).toEqual({
      left: { line: 3, text: 'z', change: 'same' },
      right: { line: 5, text: 'z', change: 'same' },
    });
  });

  it('finds an insertion in the middle of a long common run', () => {
    const base = Array.from({ length: 50 }, (_, index) => `line ${index}`);
    const changed = [...base.slice(0, 25), 'inserted', ...base.slice(25)];
    const diff = aligned(diffLines(base, changed));
    expect(diff).toMatchObject({ removed: 0, added: 1 });
    expect(diff.rows[25]).toEqual({
      left: null,
      right: { line: 26, text: 'inserted', change: 'added' },
    });
  });

  it('finds the minimal edit script and keeps both files whole (against a reference)', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const a = lines(seed, seed % 13, 4);
      const b = lines(seed * 7 + 3, (seed * 5) % 11, 4);
      const diff = aligned(diffLines(a, b));
      expect(diff.removed + diff.added, `seed ${seed}`).toBe(minimalEdits(a, b));
      expect(sides(diff.rows), `seed ${seed}`).toEqual({ left: a, right: b });
      for (const row of diff.rows) {
        if (row.left?.change === 'same') expect(row.right?.text).toBe(row.left.text);
      }
    }
  });

  it('accepts exactly the bound and refuses one edit more', () => {
    const left = Array.from({ length: 600 }, (_, index) => `left ${index}`);
    const right = Array.from({ length: 400 }, (_, index) => `right ${index}`);
    expect(left.length + right.length).toBe(FILE_DIFF_MAX_EDIT_LINES);
    expect(aligned(diffLines(left, right))).toMatchObject({ removed: 600, added: 400 });
    expect(diffLines([...left, 'one more'], right)).toMatchObject({ kind: 'too-large' });
  });

  it('ignores the common prefix and suffix when counting against the bound', () => {
    const common = Array.from({ length: 5000 }, (_, index) => `same ${index}`);
    const diff = aligned(diffLines([...common, 'a', ...common], [...common, 'b', ...common], 2));
    expect(diff).toMatchObject({ removed: 1, added: 1 });
    expect(diff.rows).toHaveLength(10_001);
  });

  it('refuses at once when the line counts alone differ by more than the bound', () => {
    expect(diffLines(['a', 'b', 'c'], [], 2)).toMatchObject({ kind: 'too-large' });
  });

  it('refuses interleaved changes above a custom bound', () => {
    expect(diffLines(['a', 'b', 'c'], ['x', 'b', 'y'], 3)).toMatchObject({ kind: 'too-large' });
    expect(aligned(diffLines(['a', 'b', 'c'], ['x', 'b', 'y'], 4))).toMatchObject({
      removed: 2,
      added: 2,
    });
  });
});

describe('diffSummary', () => {
  const sides = { left: 'A', right: 'B' };

  it('says when there is nothing to compare', () => {
    expect(diffSummary(null, sides, 'change')).toBe(
      'No line comparison: one side has no text to compare.',
    );
    // Compare-page browser QA finding 2: both sides deleted the file.
    expect(diffSummary('neither', sides, 'change')).toBe(
      'No line comparison: neither side has text to compare.',
    );
  });

  it('names the bound when the files are shown without alignment', () => {
    expect(diffSummary({ kind: 'too-large', maxEdits: 1000 }, sides, 'change')).toBe(
      'These files differ in more than 1,000 lines, so they are shown without alignment.',
    );
  });

  it('says identical files are identical', () => {
    expect(diffSummary(diffLines(['a'], ['a']), sides, 'neutral')).toBe('The files are identical.');
  });

  it('counts removed and added lines', () => {
    expect(diffSummary(diffLines(['a', 'b'], ['c']), sides, 'change')).toBe(
      '2 lines removed, 1 line added.',
    );
    expect(diffSummary(diffLines([], ['c']), sides, 'change')).toBe('1 line added.');
    expect(diffSummary(diffLines(['a'], []), sides, 'change')).toBe('1 line removed.');
  });

  it('names sides, not directions, in the neutral variant', () => {
    expect(diffSummary(diffLines(['a', 'b'], ['c']), sides, 'neutral')).toBe(
      '2 lines only in A, 1 line only in B.',
    );
    expect(diffSummary(diffLines([], ['c']), sides, 'neutral')).toBe('1 line only in B.');
    expect(diffSummary(diffLines(['a'], []), sides, 'neutral')).toBe('1 line only in A.');
  });
});
