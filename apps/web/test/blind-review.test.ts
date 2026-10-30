import { describe, expect, it, vi } from 'vitest';
import {
  BLIND_REVIEW_CLOSED_NOTICE,
  BLIND_REVIEW_NOTE_MAX_CHARS,
  casePrompt,
  loadUnlessBlindReview,
  eligiblePairsText,
  nextOpenPair,
  pairListLabel,
  preferredText,
  selectBlindPair,
  startUnavailableText,
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

describe('pair navigation (D49, D52)', () => {
  const pairs = [
    { position: 1, caseId: 'case-a', verdict: 'a' as const },
    { position: 2, caseId: 'case-a', verdict: null },
    { position: 3, caseId: 'case-b', verdict: 'tie' as const },
    { position: 4, caseId: 'case-b', verdict: null },
  ];

  it('opens the requested pair, or not found for a position the review lacks', () => {
    expect(selectBlindPair(pairs, 3, false)?.position).toBe(3);
    expect(selectBlindPair(pairs, 5, false)).toBeNull();
  });

  it('opens the first undecided pair, or the first pair when all are decided or revealed', () => {
    expect(selectBlindPair(pairs, null, false)?.position).toBe(2);
    expect(selectBlindPair(pairs, null, true)?.position).toBe(1);
    const decided = pairs.map((p) => ({ ...p, verdict: 'b' as const }));
    expect(selectBlindPair(decided, null, false)?.position).toBe(1);
    expect(selectBlindPair([], null, false)).toBeNull();
  });

  it('finds the next undecided pair after the current one, wrapping around', () => {
    expect(nextOpenPair(pairs, 2)?.position).toBe(4);
    expect(nextOpenPair(pairs, 4)?.position).toBe(2);
    expect(nextOpenPair(pairs.slice(0, 2), 2)).toBeNull();
  });

  it('labels a pair with its case and verdict', () => {
    expect(pairListLabel(pairs[0]!)).toBe('Pair 1 · case-a · A is better');
    expect(pairListLabel(pairs[1]!)).toBe('Pair 2 · case-a · No verdict');
  });
});

describe('revealed and run-page copy', () => {
  const baseline = { variant: 'baseline' as const };
  const candidate = { variant: 'candidate' as const };

  it('names the preferred variant (D54)', () => {
    expect(preferredText('a', candidate, baseline)).toBe('Candidate');
    expect(preferredText('b', candidate, baseline)).toBe('Baseline');
    expect(preferredText('a', baseline, candidate)).toBe('Baseline');
    expect(preferredText('tie', baseline, candidate)).toBe('About the same');
    expect(preferredText(null, baseline, candidate)).toBe('No verdict');
  });

  it('says why a review cannot start (D47, FR-123-50)', () => {
    const some = { eligible: 2, notCompleted: 0, notKept: 0 };
    expect(startUnavailableText('completed', some)).toBeNull();
    expect(startUnavailableText('running', some)).toBe(
      'A blind review can start after the run has completed.',
    );
    expect(startUnavailableText('error', some)).toBe(
      'A blind review needs a completed run. This run ended as error.',
    );
    expect(startUnavailableText('completed', { ...some, eligible: 0 })).toBe(
      'No pair of completed agent runs with kept files.',
    );
  });

  it('counts eligible pairs and states the closed-view notice of FR-123-52a', () => {
    expect(eligiblePairsText(1)).toBe(
      '1 pair: one per case and repetition where both agent runs completed with kept files.',
    );
    expect(eligiblePairsText(6)).toMatch(/^6 pairs: /);
    expect(BLIND_REVIEW_CLOSED_NOTICE).toBe(
      'A blind review of this run is in progress. Labelled output files and agent runs are hidden until you reveal it.',
    );
  });

  it('reads a case prompt from the stored definition, or null', () => {
    const definition = { id: 's', cases: [{ id: 'case-a', prompt: 'Do it.', extra: 1 }] };
    expect(casePrompt(definition, 'case-a')).toBe('Do it.');
    expect(casePrompt(definition, 'case-b')).toBeNull();
    expect(casePrompt({ cases: 'no' }, 'case-a')).toBeNull();
  });
});

describe('loadUnlessBlindReview (FR-123-52a, Codex review round 1)', () => {
  /** A check that answers the given states in order. */
  const states = (...answers: boolean[]) => {
    const queue = [...answers];
    return vi.fn(async () => queue.shift()!);
  };

  it('loads and returns the data while no review is unrevealed, checking before and after', async () => {
    const unrevealed = states(false, false);
    const load = vi.fn(async () => 'labelled');
    expect(await loadUnlessBlindReview(unrevealed, load)).toEqual({
      closed: false,
      value: 'labelled',
    });
    expect(unrevealed).toHaveBeenCalledTimes(2);
  });

  it('does not load at all while a review is unrevealed', async () => {
    const load = vi.fn(async () => 'labelled');
    expect(await loadUnlessBlindReview(states(true), load)).toEqual({ closed: true });
    expect(load).not.toHaveBeenCalled();
  });

  it('closes the view when a review starts while the page is loading', async () => {
    let started = false;
    const unrevealed = vi.fn(async () => started);
    const load = vi.fn(async () => {
      // Another tab starts the review while this page waits (for example for highlighting).
      started = true;
      return 'labelled';
    });
    expect(await loadUnlessBlindReview(unrevealed, load)).toEqual({ closed: true });
  });
});
