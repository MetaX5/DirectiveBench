import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createId, nowIso } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import { agentRunFiles, agentRuns, benchmarkRuns, blindReviewPairs, blindReviews } from '../schema';

/*
 * Blind review of a benchmark run's outputs (SPEC-123 §6.5, §8.3). While a review is unrevealed,
 * nothing here returns which side is baseline or candidate, an agent-run id, a repetition or an
 * execution status: the reviewer functions select only the pair's position, case, verdict and
 * note, and the files of one side by position (FR-123-52). Only `getBlindReviewResult`, after the
 * reveal, names the variants.
 */

export type BlindVerdict = NonNullable<typeof blindReviewPairs.$inferSelect.verdict>;
export type BlindSide = 'a' | 'b';

/** Why the agent runs of a benchmark run do or do not form pairs (A8). */
export interface BlindReviewEligibility {
  /** Case and repetition slots whose baseline and candidate both completed with files kept. */
  eligible: number;
  /** Slots where a side is missing or did not complete. */
  notCompleted: number;
  /** Slots where both sides completed but a side's files were not kept. */
  notKept: number;
}

interface PairableRun {
  id: string;
  caseId: string;
  repetition: number;
  variant: 'baseline' | 'candidate';
  executionStatus: string;
  outputFilesKept: boolean;
}

interface EligiblePair {
  caseId: string;
  baselineId: string;
  candidateId: string;
}

/**
 * Groups agent runs into case and repetition slots, in case then repetition order. A slot is a
 * pair only when both variants are `completed` and kept their files (A8).
 */
function pairSlots(runs: PairableRun[]): {
  eligible: EligiblePair[];
  notCompleted: number;
  notKept: number;
} {
  const slots = new Map<string, Partial<Record<PairableRun['variant'], PairableRun>>>();
  for (const run of runs) {
    const key = JSON.stringify([run.caseId, run.repetition]);
    slots.set(key, { ...slots.get(key), [run.variant]: run });
  }
  const eligible: EligiblePair[] = [];
  let notCompleted = 0;
  let notKept = 0;
  for (const { baseline, candidate } of slots.values()) {
    if (baseline?.executionStatus !== 'completed' || candidate?.executionStatus !== 'completed') {
      notCompleted += 1;
    } else if (!baseline.outputFilesKept || !candidate.outputFilesKept) {
      notKept += 1;
    } else {
      eligible.push({
        caseId: baseline.caseId,
        baselineId: baseline.id,
        candidateId: candidate.id,
      });
    }
  }
  return { eligible, notCompleted, notKept };
}

async function pairableRuns(db: Database, benchmarkRunId: string): Promise<PairableRun[]> {
  return db
    .select({
      id: agentRuns.id,
      caseId: agentRuns.caseId,
      repetition: agentRuns.repetition,
      variant: agentRuns.variant,
      executionStatus: agentRuns.executionStatus,
      outputFilesKept: agentRuns.outputFilesKept,
    })
    .from(agentRuns)
    .where(eq(agentRuns.benchmarkRunId, benchmarkRunId))
    .orderBy(asc(agentRuns.caseId), asc(agentRuns.repetition), asc(agentRuns.variant));
}

/** How many pairs a blind review of the run would have, and why the others are left out. */
export async function getBlindReviewEligibility(
  db: Database,
  benchmarkRunId: string,
): Promise<BlindReviewEligibility> {
  const { eligible, notCompleted, notKept } = pairSlots(await pairableRuns(db, benchmarkRunId));
  return { eligible: eligible.length, notCompleted, notKept };
}

/**
 * Fails the start when a pair's two sides are not two different agent runs of this benchmark run
 * and of the pair's case (FR-123-50). The pairs come from this run's rows, read in the same
 * transaction, so this guards the pairing code, not concurrent writers.
 */
export function assertBlindPairIntegrity(
  pair: { caseId: string; aAgentRunId: string; bAgentRunId: string },
  runsOfBenchmarkRun: ReadonlyMap<string, { caseId: string }>,
): void {
  const a = runsOfBenchmarkRun.get(pair.aAgentRunId);
  const b = runsOfBenchmarkRun.get(pair.bAgentRunId);
  if (
    !a ||
    !b ||
    pair.aAgentRunId === pair.bAgentRunId ||
    a.caseId !== pair.caseId ||
    b.caseId !== pair.caseId
  ) {
    throw new Error('A blind review pair must be two agent runs of one case of the benchmark run');
  }
}

/** Fisher-Yates with `crypto.randomInt`, so the order never follows ids, order or time. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Thrown inside the start transaction to roll the review row back. */
class NoEligiblePairsError extends Error {}

export type StartBlindReviewOutcome =
  | { status: 'started' | 'existing'; reviewId: string }
  | { status: 'not-found' | 'not-completed' | 'no-eligible-pairs' };

/**
 * Starts the blind review of a completed benchmark run, or returns the one it already has
 * (FR-123-50, A10). The first statement of the transaction is the conditional insert, so two
 * concurrent starts yield one review; the pairs are inserted in the same transaction, with sides
 * A and B and the pair order drawn with `crypto.randomInt` (FR-123-51).
 */
export async function startBlindReview(
  handle: DatabaseHandle,
  benchmarkRunId: string,
): Promise<StartBlindReviewOutcome> {
  try {
    return await withTransaction(handle, async (db): Promise<StartBlindReviewOutcome> => {
      const [inserted] = await db
        .insert(blindReviews)
        .select(
          db
            .select({
              id: sql<string>`${createId('brev')}`.as('id'),
              benchmarkRunId: benchmarkRuns.id,
              createdAt: sql<string>`${nowIso()}`.as('created_at'),
              revealedAt: sql<null>`null`.as('revealed_at'),
            })
            .from(benchmarkRuns)
            .where(
              and(eq(benchmarkRuns.id, benchmarkRunId), eq(benchmarkRuns.status, 'completed')),
            ),
        )
        .onConflictDoNothing({ target: blindReviews.benchmarkRunId })
        .returning({ id: blindReviews.id });
      if (!inserted) {
        const existing = await db
          .select({ id: blindReviews.id })
          .from(blindReviews)
          .where(eq(blindReviews.benchmarkRunId, benchmarkRunId))
          .get();
        if (existing) return { status: 'existing', reviewId: existing.id };
        const run = await db
          .select({ id: benchmarkRuns.id })
          .from(benchmarkRuns)
          .where(eq(benchmarkRuns.id, benchmarkRunId))
          .get();
        return { status: run ? 'not-completed' : 'not-found' };
      }

      const runs = await pairableRuns(db, benchmarkRunId);
      const { eligible } = pairSlots(runs);
      if (eligible.length === 0) throw new NoEligiblePairsError();
      const runsById = new Map(runs.map((run) => [run.id, run]));
      let position = 0;
      for (const pair of shuffle(eligible)) {
        const sides = [pair.baselineId, pair.candidateId];
        const first = randomInt(2);
        const row = {
          id: createId('bpair'),
          reviewId: inserted.id,
          position: (position += 1),
          caseId: pair.caseId,
          aAgentRunId: sides[first]!,
          bAgentRunId: sides[1 - first]!,
        };
        assertBlindPairIntegrity(row, runsById);
        await db.insert(blindReviewPairs).values(row);
      }
      return { status: 'started', reviewId: inserted.id };
    });
  } catch (error) {
    if (error instanceof NoEligiblePairsError) return { status: 'no-eligible-pairs' };
    throw error;
  }
}

/** The review as the reviewer sees it: no variant, agent-run id or repetition (FR-123-52). */
export interface BlindReviewForReviewer {
  review: { id: string; createdAt: string; revealedAt: string | null };
  pairs: {
    id: string;
    position: number;
    caseId: string;
    verdict: BlindVerdict | null;
    note: string | null;
    decidedAt: string | null;
  }[];
}

export async function getBlindReviewForReviewer(
  db: Database,
  benchmarkRunId: string,
): Promise<BlindReviewForReviewer | null> {
  const review = await db
    .select({
      id: blindReviews.id,
      createdAt: blindReviews.createdAt,
      revealedAt: blindReviews.revealedAt,
    })
    .from(blindReviews)
    .where(eq(blindReviews.benchmarkRunId, benchmarkRunId))
    .get();
  if (!review) return null;
  const pairs = await db
    .select({
      id: blindReviewPairs.id,
      position: blindReviewPairs.position,
      caseId: blindReviewPairs.caseId,
      verdict: blindReviewPairs.verdict,
      note: blindReviewPairs.note,
      decidedAt: blindReviewPairs.decidedAt,
    })
    .from(blindReviewPairs)
    .where(eq(blindReviewPairs.reviewId, review.id))
    .orderBy(asc(blindReviewPairs.position));
  return { review, pairs };
}

/** A file of one side of a pair, without the agent-run id it belongs to. */
export interface BlindPairFileSummary {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  sizeBytes: number | null;
  sha256: string | null;
  kept: 'full' | 'truncated' | 'none';
  reason: 'file-limit' | 'run-limit' | 'binary' | 'deleted' | null;
  storedBytes: number;
  redactions: number;
}

export interface BlindPairFile extends BlindPairFileSummary {
  content: string | null;
}

const blindFileColumns = {
  path: agentRunFiles.path,
  change: agentRunFiles.change,
  sizeBytes: agentRunFiles.sizeBytes,
  sha256: agentRunFiles.sha256,
  kept: agentRunFiles.kept,
  // Artifact-path entries are filtered out below, so the reason is never `artifact-path`.
  reason: sql<BlindPairFileSummary['reason']>`${agentRunFiles.reason}`,
  storedBytes: agentRunFiles.storedBytes,
  redactions: agentRunFiles.redactions,
};

/**
 * The files of side A or B of the pair at `position`, ordered by path, and the content of `path`
 * when it is one of them (FR-123-52). Artifact-path entries are left out: in a baseline without
 * the artifact their absence would reveal the variant (A7). Null when the run has no review or
 * no pair at that position.
 */
export async function getBlindPairFiles(
  db: Database,
  input: { benchmarkRunId: string; position: number; side: BlindSide; path: string | null },
): Promise<{ files: BlindPairFileSummary[]; file: BlindPairFile | null } | null> {
  const pair = await db
    .select({
      agentRunId: input.side === 'a' ? blindReviewPairs.aAgentRunId : blindReviewPairs.bAgentRunId,
    })
    .from(blindReviewPairs)
    .innerJoin(blindReviews, eq(blindReviewPairs.reviewId, blindReviews.id))
    .where(
      and(
        eq(blindReviews.benchmarkRunId, input.benchmarkRunId),
        eq(blindReviewPairs.position, input.position),
      ),
    )
    .get();
  if (!pair) return null;
  const notArtifact = or(isNull(agentRunFiles.reason), ne(agentRunFiles.reason, 'artifact-path'));
  const files = await db
    .select(blindFileColumns)
    .from(agentRunFiles)
    .where(and(eq(agentRunFiles.agentRunId, pair.agentRunId), notArtifact))
    .orderBy(asc(agentRunFiles.path));
  const file =
    input.path === null
      ? undefined
      : await db
          .select({ ...blindFileColumns, content: agentRunFiles.content })
          .from(agentRunFiles)
          .where(
            and(
              eq(agentRunFiles.agentRunId, pair.agentRunId),
              eq(agentRunFiles.path, input.path),
              notArtifact,
            ),
          )
          .get();
  return { files, file: file ?? null };
}

/** Whether the run has a review whose variants are still hidden (FR-123-52a). */
export async function hasUnrevealedBlindReview(
  db: Database,
  benchmarkRunId: string,
): Promise<boolean> {
  const row = await db
    .select({ id: blindReviews.id })
    .from(blindReviews)
    .where(and(eq(blindReviews.benchmarkRunId, benchmarkRunId), isNull(blindReviews.revealedAt)))
    .get();
  return row !== undefined;
}

export type RecordBlindVerdictOutcome = 'recorded' | 'already-decided' | 'revealed' | 'not-found';

/**
 * Records the verdict of one pair with one conditional statement: it succeeds only while the pair
 * has no verdict and its review is not revealed (FR-123-53). A recorded verdict never changes.
 */
export async function recordBlindVerdict(
  db: Database,
  input: { pairId: string; verdict: BlindVerdict; note: string | null },
): Promise<RecordBlindVerdictOutcome> {
  const [updated] = await db
    .update(blindReviewPairs)
    .set({ verdict: input.verdict, note: input.note, decidedAt: nowIso() })
    .where(
      and(
        eq(blindReviewPairs.id, input.pairId),
        isNull(blindReviewPairs.verdict),
        inArray(
          blindReviewPairs.reviewId,
          db
            .select({ id: blindReviews.id })
            .from(blindReviews)
            .where(isNull(blindReviews.revealedAt)),
        ),
      ),
    )
    .returning({ id: blindReviewPairs.id });
  if (updated) return 'recorded';
  const row = await db
    .select({ revealedAt: blindReviews.revealedAt })
    .from(blindReviewPairs)
    .innerJoin(blindReviews, eq(blindReviewPairs.reviewId, blindReviews.id))
    .where(eq(blindReviewPairs.id, input.pairId))
    .get();
  if (!row) return 'not-found';
  return row.revealedAt === null ? 'already-decided' : 'revealed';
}

export type RevealBlindReviewOutcome = 'revealed' | 'already-revealed' | 'not-found';

/** Reveals every pair of a review and ends it, with one conditional statement (FR-123-54, A9). */
export async function revealBlindReview(
  db: Database,
  reviewId: string,
): Promise<RevealBlindReviewOutcome> {
  const [updated] = await db
    .update(blindReviews)
    .set({ revealedAt: nowIso() })
    .where(and(eq(blindReviews.id, reviewId), isNull(blindReviews.revealedAt)))
    .returning({ id: blindReviews.id });
  if (updated) return 'revealed';
  const row = await db
    .select({ id: blindReviews.id })
    .from(blindReviews)
    .where(eq(blindReviews.id, reviewId))
    .get();
  return row ? 'already-revealed' : 'not-found';
}

/** One side of a revealed pair. */
export interface RevealedSide {
  agentRunId: string;
  variant: 'baseline' | 'candidate';
  repetition: number;
}

export interface BlindReviewResult {
  reviewId: string;
  revealedAt: string;
  pairs: {
    position: number;
    caseId: string;
    a: RevealedSide;
    b: RevealedSide;
    verdict: BlindVerdict | null;
    note: string | null;
  }[];
  /** "Candidate preferred in X of N pairs, baseline in Y, about the same in Z, no verdict in W." */
  summary: { pairs: number; candidate: number; baseline: number; tie: number; none: number };
}

const sideA = alias(agentRuns, 'side_a');
const sideB = alias(agentRuns, 'side_b');

/** The variants and the summary of a revealed review; null while it is unrevealed (FR-123-54). */
export async function getBlindReviewResult(
  db: Database,
  benchmarkRunId: string,
): Promise<BlindReviewResult | null> {
  const review = await db
    .select({ id: blindReviews.id, revealedAt: blindReviews.revealedAt })
    .from(blindReviews)
    .where(eq(blindReviews.benchmarkRunId, benchmarkRunId))
    .get();
  if (!review?.revealedAt) return null;
  const rows = await db
    .select({
      position: blindReviewPairs.position,
      caseId: blindReviewPairs.caseId,
      a: { agentRunId: sideA.id, variant: sideA.variant, repetition: sideA.repetition },
      b: { agentRunId: sideB.id, variant: sideB.variant, repetition: sideB.repetition },
      verdict: blindReviewPairs.verdict,
      note: blindReviewPairs.note,
    })
    .from(blindReviewPairs)
    .innerJoin(sideA, eq(blindReviewPairs.aAgentRunId, sideA.id))
    .innerJoin(sideB, eq(blindReviewPairs.bAgentRunId, sideB.id))
    .where(eq(blindReviewPairs.reviewId, review.id))
    .orderBy(asc(blindReviewPairs.position));
  const summary = { pairs: rows.length, candidate: 0, baseline: 0, tie: 0, none: 0 };
  for (const row of rows) {
    if (row.verdict === null) summary.none += 1;
    else if (row.verdict === 'tie') summary.tie += 1;
    else summary[row[row.verdict].variant] += 1;
  }
  return { reviewId: review.id, revealedAt: review.revealedAt, pairs: rows, summary };
}
