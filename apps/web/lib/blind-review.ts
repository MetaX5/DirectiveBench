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

/** What a closed labelled view says while a review is unrevealed (FR-123-52a, D55). */
export const BLIND_REVIEW_CLOSED_NOTICE =
  'A blind review of this run is in progress. Labelled output files and agent runs are hidden until you reveal it.';

/** The pairs and what a pair page reads of them. */
interface ReviewPair {
  position: number;
  caseId: string;
  verdict: BlindVerdict | null;
}

/**
 * The pair a review page shows (D49): the requested position, or without one the first pair
 * without a verdict (the first pair once all are decided or the review is revealed). Null for
 * a position the review does not have, which the page renders as not found (§10).
 */
export function selectBlindPair<P extends ReviewPair>(
  pairs: readonly P[],
  requested: number | null,
  revealed: boolean,
): P | null {
  if (requested !== null) return pairs.find((pair) => pair.position === requested) ?? null;
  const open = revealed ? undefined : pairs.find((pair) => pair.verdict === null);
  return open ?? pairs[0] ?? null;
}

/** The next pair without a verdict after `position`, wrapping around; null when none is left. */
export function nextOpenPair<P extends ReviewPair>(
  pairs: readonly P[],
  position: number,
): P | null {
  const after = pairs.filter((pair) => pair.position > position);
  const before = pairs.filter((pair) => pair.position < position);
  return [...after, ...before].find((pair) => pair.verdict === null) ?? null;
}

/** A pair in the "Pairs" list: "Pair 1 · case-a · A is better" (D49). */
export function pairListLabel(pair: ReviewPair): string {
  const verdict = pair.verdict === null ? 'No verdict' : BLIND_VERDICT_LABELS[pair.verdict];
  return `Pair ${pair.position} · ${pair.caseId} · ${verdict}`;
}

/** Which variant a revealed verdict preferred (D54). */
export function preferredText(
  verdict: BlindVerdict | null,
  a: { variant: 'baseline' | 'candidate' },
  b: { variant: 'baseline' | 'candidate' },
): string {
  if (verdict === null) return 'No verdict';
  if (verdict === 'tie') return 'About the same';
  return (verdict === 'a' ? a : b).variant === 'candidate' ? 'Candidate' : 'Baseline';
}

/**
 * Why the run page offers no "Start blind review" (D47), or null when it does: the run must be
 * completed and have at least one eligible pair (FR-123-50).
 */
export function startUnavailableText(
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted',
  eligibility: BlindReviewEligibility,
): string | null {
  if (status === 'running') return 'A blind review can start after the run has completed.';
  if (status !== 'completed') {
    return `A blind review needs a completed run. This run ended as ${status}.`;
  }
  return eligibility.eligible === 0 ? 'No pair of completed agent runs with kept files.' : null;
}

/** "6 pairs: one per case and repetition where both agent runs completed with kept files." */
export function eligiblePairsText(eligible: number): string {
  return `${count(eligible, 'pair', 'pairs')}: one per case and repetition where both agent runs completed with kept files.`;
}

const definitionCasesSchema = z.object({
  cases: z.array(z.object({ id: z.string(), prompt: z.string() })),
});

/** The prompt of a case from the stored suite definition, or null when it cannot be read. */
export function casePrompt(definition: unknown, caseId: string): string | null {
  const parsed = definitionCasesSchema.safeParse(definition);
  if (!parsed.success) return null;
  return parsed.data.cases.find((c) => c.id === caseId)?.prompt ?? null;
}

/** Labelled data, or `closed` when a blind review of the run is unrevealed (FR-123-52a). */
export type UnlessBlindReview<T> = { closed: true } | { closed: false; value: T };

/**
 * Loads a labelled view's data unless the run has an unrevealed blind review, checked before
 * the load and again after it, right before the page renders: a review started in another tab
 * while the page was loading (or waiting for syntax highlighting) closes the view too (Codex
 * review, round 1). Nothing is awaited between the second check and the render.
 */
export async function loadUnlessBlindReview<T>(
  unrevealed: () => Promise<boolean>,
  load: () => Promise<T>,
): Promise<UnlessBlindReview<T>> {
  if (await unrevealed()) return { closed: true };
  const value = await load();
  return (await unrevealed()) ? { closed: true } : { closed: false, value };
}
