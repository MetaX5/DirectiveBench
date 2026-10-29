// A bounded line diff for comparing two output files side by side (SPEC-123 A12, FR-123-31).
// Myers' O((N+M)·D) algorithm after trimming the common prefix and suffix, stopped once the
// edit distance D (removed plus added lines) passes FILE_DIFF_MAX_EDIT_LINES, so two 1 MB files
// cost at most (N+M)·1000 line comparisons and about 1,000² stored diagonals. No dependency.

/** Changed lines (removed plus added) above which two files are shown without alignment. */
export const FILE_DIFF_MAX_EDIT_LINES = 1000;

export type DiffChange = 'same' | 'removed' | 'added';

export interface DiffCell {
  /** 1-based line number in its own file. */
  line: number;
  text: string;
  change: DiffChange;
}

/** One aligned row: a cell is null where the other side has a line this side lacks. */
export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
}

export type LineDiff =
  | { kind: 'aligned'; rows: DiffRow[]; removed: number; added: number }
  | { kind: 'too-large'; maxEdits: number };

type Op = 'equal' | 'delete' | 'insert';

/**
 * Aligns `left` and `right` line by line. Within a run of changes, removed and added lines are
 * paired row by row, and the longer side continues against empty cells.
 */
export function diffLines(
  left: readonly string[],
  right: readonly string[],
  maxEdits: number = FILE_DIFF_MAX_EDIT_LINES,
): LineDiff {
  // Interning turns each comparison in the inner loop into an integer comparison.
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const a = left.map(intern);
  const b = right.map(intern);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const middle = editScript(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (middle === null) return { kind: 'too-large', maxEdits };
  const ops: Op[] = [
    ...Array<Op>(start).fill('equal'),
    ...middle,
    ...Array<Op>(a.length - endA).fill('equal'),
  ];
  return align(ops, left, right);
}

/** Myers' shortest edit script, or null when it needs more than `maxEdits` edits. */
function editScript(a: readonly number[], b: readonly number[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  // Every extra line on one side is at least one edit.
  if (Math.abs(n - m) > maxEdits) return null;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] keeps the diagonals -d-1 … d+1 as they were before step d, for the backtrack.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const row = trace[d]!;
    const at = (k: number): number => row[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('equal');
      x -= 1;
      y -= 1;
    }
    if (d > 0) ops.push(x === prevX ? 'insert' : 'delete');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function align(ops: readonly Op[], left: readonly string[], right: readonly string[]): LineDiff {
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];
  let removedCount = 0;
  let addedCount = 0;
  const flush = (): void => {
    for (let r = 0; r < Math.max(removed.length, added.length); r += 1) {
      rows.push({ left: removed[r] ?? null, right: added[r] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op === 'delete') {
      removed.push({ line: i + 1, text: left[i]!, change: 'removed' });
      i += 1;
      removedCount += 1;
    } else if (op === 'insert') {
      added.push({ line: j + 1, text: right[j]!, change: 'added' });
      j += 1;
      addedCount += 1;
    } else {
      flush();
      rows.push({
        left: { line: i + 1, text: left[i]!, change: 'same' },
        right: { line: j + 1, text: right[j]!, change: 'same' },
      });
      i += 1;
      j += 1;
    }
  }
  flush();
  return { kind: 'aligned', rows, removed: removedCount, added: addedCount };
}

/**
 * How a side-by-side diff labels changes: `change` reads left to right as removed and added
 * lines; `neutral` says only which side has a line, with no direction or judgement (blind review).
 */
export type DiffVariant = 'change' | 'neutral';

const count = new Intl.NumberFormat('en-US');
const lineCount = (n: number): string => `${count.format(n)} ${n === 1 ? 'line' : 'lines'}`;

/** The one-sentence result above a side-by-side diff (SPEC-123 FR-123-31, §14). */
export function diffSummary(
  diff: LineDiff | null,
  sides: { left: string; right: string },
  variant: DiffVariant,
): string {
  if (diff === null) return 'No line comparison: one side has no text to compare.';
  if (diff.kind === 'too-large') {
    return `These files differ in more than ${count.format(diff.maxEdits)} lines, so they are shown without alignment.`;
  }
  if (diff.removed + diff.added === 0) return 'The files are identical.';
  const parts =
    variant === 'change'
      ? [
          diff.removed > 0 ? `${lineCount(diff.removed)} removed` : null,
          diff.added > 0 ? `${lineCount(diff.added)} added` : null,
        ]
      : [
          diff.removed > 0 ? `${lineCount(diff.removed)} only in ${sides.left}` : null,
          diff.added > 0 ? `${lineCount(diff.added)} only in ${sides.right}` : null,
        ];
  return `${parts.filter((part) => part !== null).join(', ')}.`;
}
