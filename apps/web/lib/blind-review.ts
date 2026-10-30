// Rules of the blind review (SPEC-123 §6.5, §10, §13): input schemas shared by the server
// actions, query parsing of the review page, copy for outcomes and the revealed summary. Pure
// functions, so the page and the actions stay thin and every rule is unit-tested.

import type {
  BlindReviewEligibility,
  BlindReviewResult,
  BlindVerdict,
  RecordBlindVerdictOutcome,
  RevealBlindReviewOutcome,
  StartBlindReviewOutcome,
} from '@directivebench/database';
import { z } from 'zod';
import { parsePathParam } from './agent-run-files';
import type { MetadataFormState } from './artifact-metadata';

/** The longest note a verdict may carry, in characters (SPEC-123 A11, §8.2). */
export const BLIND_REVIEW_NOTE_MAX_CHARS = 2_000;

/** The form state the blind-review actions return (the shape of the metadata forms). */
export type BlindReviewFormState = MetadataFormState;

export const BLIND_VERDICT_LABELS: Record<BlindVerdict, string> = {
  a: 'A is better',
  b: 'B is better',
  tie: 'About the same',
};

const idSchema = z.string().min(1).max(200);

export const startBlindReviewSchema = z.object({ benchmarkRunId: idSchema });

/**
 * A verdict for one pair. The note is the reviewer's own text: CR LF becomes LF (as typed), the
 * length is checked after that, and a note of only whitespace is no note.
 */
export const recordBlindVerdictSchema = z.object({
  benchmarkRunId: idSchema,
  pairId: idSchema,
  verdict: z.enum(['a', 'b', 'tie']),
  note: z
    .string({ error: 'Enter the note as text.' })
    .transform((value) => value.replace(/\r\n?/g, '\n'))
    .pipe(
      z
        .string()
        .max(
          BLIND_REVIEW_NOTE_MAX_CHARS,
          `A note can be at most ${BLIND_REVIEW_NOTE_MAX_CHARS.toLocaleString('en-US')} characters. Shorten it.`,
        ),
    )
    .transform((value) => (value.trim() === '' ? null : value)),
});

export const revealBlindReviewSchema = z.object({ benchmarkRunId: idSchema, reviewId: idSchema });

type SearchParams = Record<string, string | string[] | undefined>;

/** The review page's query: `pair` is absent (null), a position from 1, or invalid. */
export interface BlindReviewQuery {
  pair: number | 'invalid' | null;
  path: string | null;
}

const pairParamSchema = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .transform(Number);

/**
 * Parses `?pair=&path=` (§10). An empty or repeated value counts as absent, as on the other
 * output-file pages (D33); a `pair` that is not a position is invalid, which the page renders as
 * not found.
 */
export function parseBlindReviewQuery(params: SearchParams): BlindReviewQuery {
  const raw = parsePathParam(params.pair);
  const pair = raw === null ? null : pairParamSchema.safeParse(raw);
  return {
    pair: pair === null ? null : pair.success ? pair.data : 'invalid',
    path: parsePathParam(params.path),
  };
}

/** The review page of a run, at a pair and a path; the URL never holds an agent-run id. */
export function blindReviewHref(
  benchmarkRunId: string,
  at: { pair?: number; path?: string } = {},
): string {
  const query = new URLSearchParams();
  if (at.pair !== undefined) query.set('pair', String(at.pair));
  if (at.path !== undefined) query.set('path', at.path);
  const search = query.toString();
  return `/results/${encodeURIComponent(benchmarkRunId)}/blind-review${search ? `?${search}` : ''}`;
}

/** Why a start was refused (§13); null when the review was started or already existed. */
export function startRefusal(outcome: StartBlindReviewOutcome): string | null {
  switch (outcome.status) {
    case 'started':
    case 'existing':
      return null;
    case 'no-eligible-pairs':
      return 'No pair of completed agent runs with kept files.';
    case 'not-completed':
      return 'A blind review can start only after the run has completed.';
    case 'not-found':
      return 'This benchmark run no longer exists.';
  }
}

/** The form state after a verdict (FR-123-53, §13). */
export function verdictState(outcome: RecordBlindVerdictOutcome): BlindReviewFormState {
  switch (outcome) {
    case 'recorded':
      return { kind: 'success', message: 'Verdict recorded.' };
    case 'already-decided':
      return { kind: 'error', message: 'This pair already has a verdict.' };
    case 'revealed':
      return { kind: 'error', message: 'This review was revealed; verdicts are closed.' };
    case 'not-found':
      return { kind: 'error', message: 'This pair no longer exists.' };
  }
}

/** The form state after a reveal (FR-123-54). */
export function revealState(outcome: RevealBlindReviewOutcome): BlindReviewFormState {
  switch (outcome) {
    case 'revealed':
      return { kind: 'success', message: 'Variants revealed. The blind review has ended.' };
    case 'already-revealed':
      return { kind: 'success', message: 'This review was already revealed.' };
    case 'not-found':
      return { kind: 'error', message: 'This review no longer exists.' };
  }
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "Candidate preferred in X of N pairs, baseline in Y, about the same in Z, no verdict in W." */
export function blindReviewSummaryText(summary: BlindReviewResult['summary']): string {
  return (
    `Candidate preferred in ${summary.candidate} of ${count(summary.pairs, 'pair', 'pairs')}, ` +
    `baseline in ${summary.baseline}, about the same in ${summary.tie}, ` +
    `no verdict in ${summary.none}.`
  );
}

/** "Pairs decided: 2 of 6" (§11). */
export function decidedText(pairs: readonly { verdict: BlindVerdict | null }[]): string {
  const decided = pairs.filter((pair) => pair.verdict !== null).length;
  return `Pairs decided: ${decided} of ${pairs.length}`;
}

/**
 * The pairs left out of a review and why (§14): "1 pair excluded: an agent run did not
 * complete." Empty when every case and repetition is a pair.
 */
export function excludedPairsText(eligibility: BlindReviewEligibility): string[] {
  const lines: string[] = [];
  if (eligibility.notCompleted > 0) {
    lines.push(
      `${count(eligibility.notCompleted, 'pair', 'pairs')} excluded: an agent run did not complete.`,
    );
  }
  if (eligibility.notKept > 0) {
    lines.push(
      `${count(eligibility.notKept, 'pair', 'pairs')} excluded: the output files of an agent run were not kept.`,
    );
  }
  return lines;
}
