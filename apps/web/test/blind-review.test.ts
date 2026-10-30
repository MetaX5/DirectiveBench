import { describe, expect, it } from 'vitest';
import {
  BLIND_REVIEW_NOTE_MAX_CHARS,
  BLIND_VERDICT_LABELS,
  blindReviewHref,
  blindReviewSummaryText,
  decidedText,
  excludedPairsText,
  parseBlindReviewQuery,
  recordBlindVerdictSchema,
  startRefusal,
} from '../lib/blind-review';

describe('parseBlindReviewQuery', () => {
  it('reads a pair position and a path', () => {
    expect(parseBlindReviewQuery({ pair: '3', path: 'src/a.ts' })).toEqual({
      pair: 3,
      path: 'src/a.ts',
    });
    expect(parseBlindReviewQuery({ pair: '999999' }).pair).toBe(999_999);
  });

  it('treats an empty or repeated value as absent (D33)', () => {
    expect(parseBlindReviewQuery({})).toEqual({ pair: null, path: null });
    expect(parseBlindReviewQuery({ pair: '', path: '' })).toEqual({ pair: null, path: null });
    expect(parseBlindReviewQuery({ pair: ['1', '2'], path: ['a', 'b'] })).toEqual({
      pair: null,
      path: null,
    });
  });

  it.each(['0', '-1', '1.5', '01', 'a', '1e3', '1000000', ' 1'])(
    'marks pair %j as invalid (not found, §10)',
    (pair) => {
      expect(parseBlindReviewQuery({ pair }).pair).toBe('invalid');
    },
  );
});

describe('blindReviewHref', () => {
  it('carries only the pair position and the path, encoded', () => {
    expect(blindReviewHref('run_1')).toBe('/results/run_1/blind-review');
    expect(blindReviewHref('run/1', { pair: 2, path: 'a b&c.ts' })).toBe(
      '/results/run%2F1/blind-review?pair=2&path=a+b%26c.ts',
    );
    expect(blindReviewHref('run_1', { path: 'x' })).toBe('/results/run_1/blind-review?path=x');
  });
});

describe('recordBlindVerdictSchema', () => {
  const base = { benchmarkRunId: 'run_1', pairId: 'bpair_1', verdict: 'b' };

  it('normalises line breaks before the limit and drops a blank note', () => {
    const exact = 'x'.repeat(BLIND_REVIEW_NOTE_MAX_CHARS - 1);
    expect(recordBlindVerdictSchema.parse({ ...base, note: `${exact}\r\n` }).note).toBe(
      `${exact}\n`,
    );
    expect(recordBlindVerdictSchema.parse({ ...base, note: ' \r\n\t' }).note).toBeNull();
  });

  it('refuses a note over the limit, a non-text note and an unknown verdict', () => {
    expect(
      recordBlindVerdictSchema.safeParse({
        ...base,
        note: 'x'.repeat(BLIND_REVIEW_NOTE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    const nonText = recordBlindVerdictSchema.safeParse({ ...base, note: 5 });
    expect(nonText.error?.issues[0]?.message).toBe('Enter the note as text.');
    expect(recordBlindVerdictSchema.safeParse({ ...base, verdict: 'tie ', note: '' }).success).toBe(
      false,
    );
  });
});

describe('copy', () => {
  it('labels the verdicts as the spec does (A11)', () => {
    expect(BLIND_VERDICT_LABELS).toEqual({
      a: 'A is better',
      b: 'B is better',
      tie: 'About the same',
    });
  });

  it('gives no refusal for a started or existing review, and the reason otherwise', () => {
    expect(startRefusal({ status: 'started', reviewId: 'r' })).toBeNull();
    expect(startRefusal({ status: 'existing', reviewId: 'r' })).toBeNull();
    expect(startRefusal({ status: 'no-eligible-pairs' })).toBe(
      'No pair of completed agent runs with kept files.',
    );
  });

  it('summarises a revealed review (FR-123-54)', () => {
    expect(blindReviewSummaryText({ pairs: 6, candidate: 3, baseline: 1, tie: 1, none: 1 })).toBe(
      'Candidate preferred in 3 of 6 pairs, baseline in 1, about the same in 1, no verdict in 1.',
    );
    expect(blindReviewSummaryText({ pairs: 1, candidate: 0, baseline: 0, tie: 0, none: 1 })).toBe(
      'Candidate preferred in 0 of 1 pair, baseline in 0, about the same in 0, no verdict in 1.',
    );
  });

  it('counts decided pairs', () => {
    expect(decidedText([{ verdict: 'a' }, { verdict: null }, { verdict: 'tie' }])).toBe(
      'Pairs decided: 2 of 3',
    );
  });

  it('names the excluded pairs and why (§14)', () => {
    expect(excludedPairsText({ eligible: 2, notCompleted: 0, notKept: 0 })).toEqual([]);
    expect(excludedPairsText({ eligible: 2, notCompleted: 1, notKept: 2 })).toEqual([
      '1 pair excluded: an agent run did not complete.',
      '2 pairs excluded: the output files of an agent run were not kept.',
    ]);
  });
});
