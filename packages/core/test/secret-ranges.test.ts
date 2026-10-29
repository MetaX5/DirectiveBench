import { describe, expect, it } from 'vitest';
import {
  findSecretRanges,
  mergeTextRanges,
  REDACTION_MARKER,
  replaceTextRanges,
  SECRET_PATTERN_MIN_LENGTHS,
  SECRET_PATTERNS,
  type TextRange,
} from '../src/redact';

const KNOWN = 'known-secret-value-123';
const fileEnd = { textEnd: 'file-end' } as const;
const cut = { textEnd: 'cut' } as const;

/** The texts the ranges cover, in order. */
function covered(text: string, ranges: readonly TextRange[]): string[] {
  return ranges.map((r) => text.slice(r.start, r.end));
}

describe('SECRET_PATTERN_MIN_LENGTHS', () => {
  // The shortest text each pattern matches, in pattern order.
  const samples = [
    `sk-ant-${'a'.repeat(16)}`,
    `sk-${'a'.repeat(20)}`,
    `ghp_${'a'.repeat(20)}`,
    `github_pat_${'a'.repeat(20)}`,
    `glpat-${'a'.repeat(20)}`,
    `xoxb-${'a'.repeat(10)}`,
    `AKIA${'A'.repeat(16)}`,
    'authorization:bearer x',
  ];

  it('lists one length per pattern, each the length of a shortest match', () => {
    expect(SECRET_PATTERN_MIN_LENGTHS).toHaveLength(SECRET_PATTERNS.length);
    SECRET_PATTERNS.forEach((pattern, i) => {
      const sample = samples[i] as string;
      expect(sample).toHaveLength(SECRET_PATTERN_MIN_LENGTHS[i] as number);
      const exact = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace('g', ''));
      expect(exact.test(sample)).toBe(true);
      // One character shorter no longer matches.
      expect(exact.test(sample.slice(0, -1))).toBe(false);
    });
  });
});

describe('mergeTextRanges', () => {
  it('sorts, merges overlapping and adjacent ranges and drops empty ones', () => {
    expect(
      mergeTextRanges([
        { start: 10, end: 12 },
        { start: 0, end: 3 },
        { start: 2, end: 5 },
        { start: 5, end: 6 },
        { start: 8, end: 8 },
        { start: 11, end: 11 },
      ]),
    ).toEqual([
      { start: 0, end: 6 },
      { start: 10, end: 12 },
    ]);
  });

  it('keeps a contained range inside the larger one', () => {
    expect(
      mergeTextRanges([
        { start: 0, end: 10 },
        { start: 2, end: 4 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('findSecretRanges (SPEC-123 FR-123-07)', () => {
  it('finds every occurrence of a known secret and ignores too-short ones', () => {
    const text = `a ${KNOWN} b ${KNOWN}${KNOWN} short1`;
    const ranges = findSecretRanges(text, [KNOWN, 'short1'], fileEnd);
    expect(covered(text, ranges)).toEqual([KNOWN, `${KNOWN}${KNOWN}`]);
  });

  it('finds overlapping occurrences of a known secret', () => {
    const secret = 'abababab';
    const text = 'xababababab';
    expect(covered(text, findSecretRanges(text, [secret], fileEnd))).toEqual(['ababababab']);
  });

  it('finds every pattern match, keeping the authorization prefix outside the range', () => {
    const token = `sk-ant-${'x'.repeat(20)}`;
    const text = `key=${token}\nAuthorization: Bearer abc.def\nAKIA${'B'.repeat(16)} end`;
    expect(covered(text, findSecretRanges(text, [], fileEnd))).toEqual([
      token,
      'abc.def',
      `AKIA${'B'.repeat(16)}`,
    ]);
  });

  it('redacts a complete private-key block between its markers', () => {
    const text = 'a -----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY----- b';
    expect(covered(text, findSecretRanges(text, [], fileEnd))).toEqual(['\nbody\n']);
  });

  it('redacts after a BEGIN without END to the end of the text', () => {
    const text = 'head -----BEGIN PRIVATE KEY-----\nbody';
    expect(covered(text, findSecretRanges(text, [], fileEnd))).toEqual(['\nbody']);
    expect(covered(text, findSecretRanges(text, [], cut))).toEqual(['\nbody']);
  });

  it('redacts the text before an END that does not follow its BEGIN', () => {
    const text = 'fragment\n-----END PRIVATE KEY----- tail -----END PRIVATE KEY-----';
    expect(covered(text, findSecretRanges(text, [], fileEnd))).toEqual(['fragment\n', ' tail ']);
  });

  it('keeps the text between an END and the next BEGIN', () => {
    const text =
      '-----BEGIN PRIVATE KEY-----a-----END PRIVATE KEY----- keep -----BEGIN PRIVATE KEY-----b-----END PRIVATE KEY-----';
    expect(covered(text, findSecretRanges(text, [], fileEnd))).toEqual(['a', 'b']);
  });

  it('adds the longest suffix that starts a known secret only for a cut text', () => {
    const text = `text ${KNOWN.slice(0, 9)}`;
    expect(findSecretRanges(text, [KNOWN], fileEnd)).toEqual([]);
    expect(covered(text, findSecretRanges(text, [KNOWN], cut))).toEqual([KNOWN.slice(0, 9)]);
    // A text shorter than the secret is itself a prefix.
    expect(covered('kno', findSecretRanges('kno', [KNOWN], cut))).toEqual(['kno']);
    expect(findSecretRanges('no match here', [KNOWN], cut)).toEqual([]);
  });

  it('returns nothing for text without secrets', () => {
    expect(findSecretRanges('plain text [REDACTED]', [KNOWN], cut)).toEqual([]);
  });
});

describe('replaceTextRanges', () => {
  it('replaces each range by the marker', () => {
    const text = `a ${KNOWN} b ${KNOWN}`;
    expect(replaceTextRanges(text, findSecretRanges(text, [KNOWN], fileEnd))).toBe(
      `a ${REDACTION_MARKER} b ${REDACTION_MARKER}`,
    );
    expect(replaceTextRanges('plain', [])).toBe('plain');
  });
});
