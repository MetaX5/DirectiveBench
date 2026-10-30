import type * as Crypto from 'node:crypto';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  finishBenchmarkRun,
  getBlindPairFiles,
  getBlindReviewEligibility,
  getBlindReviewForReviewer,
  getBlindReviewResult,
  hasUnrevealedBlindReview,
  insertAgentRun,
  recordBlindVerdict,
  revealBlindReview,
  schema,
  startBlindReview,
  type AgentRunFileInput,
  type AgentRunInput,
  type DatabaseHandle,
} from '../src/index';
import { assertBlindPairIntegrity } from '../src/repositories/blind-reviews';
import { seedRun, seedTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// `randomInt` stays the real one unless a test queues values, so the draw itself is observable.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const getHandle = useTestDatabase();
/** The one-argument overload the code under test calls. */
const draw = vi.mocked(randomInt as (max: number) => number);

afterEach(() => {
  draw.mockClear();
});

function agentRun(benchmarkRunId: string, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    benchmarkRunId,
    caseId: 'case-a',
    variant: 'baseline',
    repetition: 1,
    fixtureVersionId: 'sha-1',
    executionStatus: 'completed',
    score: 1,
    passed: true,
    durationMs: 12,
    changedFiles: [],
    trace: [],
    usage: null,
    error: null,
    assertions: [],
    outputFilesKept: true,
    outputFilesReason: null,
    outputFiles: [],
    ...overrides,
  };
}

function outputFile(path: string, overrides: Partial<AgentRunFileInput> = {}): AgentRunFileInput {
  return {
    path,
    change: 'added',
    sizeBytes: 5,
    sha256: 'f'.repeat(64),
    kept: 'full',
    reason: null,
    content: `content of ${path}`,
    storedBytes: 5,
    redactions: 0,
    ...overrides,
  };
}

async function completedRun(handle: DatabaseHandle): Promise<string> {
  const runId = await seedRun(handle, await seedTargets(handle));
  await finishBenchmarkRun(handle.db, runId, {
    status: 'completed',
    verdict: 'improved',
    summary: null,
    comparabilityKey: null,
    warnings: [],
    error: null,
  });
  return runId;
}

/** A completed run with one eligible pair per case and repetition given. */
async function runWithPairs(
  handle: DatabaseHandle,
  slots: { caseId: string; repetition: number }[],
): Promise<{ runId: string; ids: Map<string, string> }> {
  const runId = await completedRun(handle);
  const ids = new Map<string, string>();
  for (const slot of slots) {
    for (const variant of ['baseline', 'candidate'] as const) {
      const id = await insertAgentRun(
        handle,
        agentRun(runId, {
          ...slot,
          variant,
          outputFiles: [
            outputFile(`${variant}.txt`),
            outputFile('shared.txt', { content: `${variant} text` }),
          ],
        }),
      );
      ids.set(`${slot.caseId}/${slot.repetition}/${variant}`, id);
    }
  }
  return { runId, ids };
}

describe('getBlindReviewEligibility', () => {
  it('counts eligible pairs and why the other case and repetition slots are left out (A8)', async () => {
    const handle = getHandle();
    const runId = await completedRun(handle);
    const add = (overrides: Partial<AgentRunInput>) =>
      insertAgentRun(handle, agentRun(runId, overrides));
    await add({ caseId: 'ok', variant: 'baseline' });
    await add({ caseId: 'ok', variant: 'candidate' });
    await add({ caseId: 'error', variant: 'baseline' });
    await add({ caseId: 'error', variant: 'candidate', executionStatus: 'agent-error' });
    await add({ caseId: 'error', variant: 'baseline', repetition: 2, executionStatus: 'timeout' });
    await add({ caseId: 'error', variant: 'candidate', repetition: 2 });
    await add({ caseId: 'lonely', variant: 'candidate' });
    await add({ caseId: 'unkept', variant: 'baseline', outputFilesKept: false });
    await add({ caseId: 'unkept', variant: 'candidate' });
    await add({ caseId: 'unkept', variant: 'baseline', repetition: 2 });
    await add({ caseId: 'unkept', variant: 'candidate', repetition: 2, outputFilesKept: false });

    expect(await getBlindReviewEligibility(handle.db, runId)).toEqual({
      eligible: 1,
      notCompleted: 3,
      notKept: 2,
    });
    expect(await getBlindReviewEligibility(handle.db, 'run_missing')).toEqual({
      eligible: 0,
      notCompleted: 0,
      notKept: 0,
    });
  });
});

describe('startBlindReview', () => {
  it('creates one pair per eligible slot, each a baseline and a candidate of one case and repetition (FR-123-50, FR-123-51)', async () => {
    const handle = getHandle();
    const { runId, ids } = await runWithPairs(handle, [
      { caseId: 'case-a', repetition: 1 },
      { caseId: 'case-a', repetition: 2 },
      { caseId: 'case-b', repetition: 1 },
    ]);
    await insertAgentRun(handle, agentRun(runId, { caseId: 'case-c', executionStatus: 'timeout' }));

    const outcome = await startBlindReview(handle, runId);
    expect(outcome).toEqual({ status: 'started', reviewId: expect.stringMatching(/^brev_/) });

    const pairs = await handle.db.select().from(schema.blindReviewPairs);
    expect(pairs.map((p) => p.position).sort()).toEqual([1, 2, 3]);
    const slotsSeen = pairs.map((pair) => {
      const sides = [pair.aAgentRunId, pair.bAgentRunId];
      const slot = [...ids].filter(([, id]) => sides.includes(id)).map(([key]) => key);
      expect(slot).toHaveLength(2);
      const [baseline, candidate] = slot.sort();
      expect(baseline).toMatch(new RegExp(`^${pair.caseId}/\\d/baseline$`));
      expect(candidate).toBe(baseline!.replace('baseline', 'candidate'));
      expect(pair).toMatchObject({ verdict: null, note: null, decidedAt: null });
      return baseline!.replace('/baseline', '');
    });
    expect(slotsSeen.sort()).toEqual(['case-a/1', 'case-a/2', 'case-b/1']);
    // One draw per shuffle step (two for three pairs) and one per pair for its sides.
    expect(draw.mock.calls).toEqual([[3], [2], [2], [2], [2]]);
  });

  it('puts the side and the order where crypto.randomInt says, never by id or time (FR-123-51)', async () => {
    const handle = getHandle();
    const { runId, ids } = await runWithPairs(handle, [
      { caseId: 'case-a', repetition: 1 },
      { caseId: 'case-b', repetition: 1 },
    ]);
    // Shuffle: swap index 1 with 0 (case-b first); then case-b keeps baseline as A, case-a swaps.
    draw.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1);
    await startBlindReview(handle, runId);
    const pairs = await handle.db
      .select()
      .from(schema.blindReviewPairs)
      .orderBy(schema.blindReviewPairs.position);
    expect(pairs.map((p) => [p.position, p.caseId, p.aAgentRunId, p.bAgentRunId])).toEqual([
      [1, 'case-b', ids.get('case-b/1/baseline'), ids.get('case-b/1/candidate')],
      [2, 'case-a', ids.get('case-a/1/candidate'), ids.get('case-a/1/baseline')],
    ]);
  });

  it('returns the existing review on a second start and on two concurrent starts (A10)', async () => {
    const handle = getHandle();
    const { runId } = await runWithPairs(handle, [{ caseId: 'case-a', repetition: 1 }]);
    const [first, second] = await Promise.all([
      startBlindReview(handle, runId),
      startBlindReview(handle, runId),
    ]);
    expect(first).toEqual({ status: 'started', reviewId: expect.any(String) });
    expect(second).toEqual({
      status: 'existing',
      reviewId: (first as { reviewId: string }).reviewId,
    });
    expect(await startBlindReview(handle, runId)).toEqual(second);
    expect(await handle.db.select().from(schema.blindReviews)).toHaveLength(1);
    expect(await handle.db.select().from(schema.blindReviewPairs)).toHaveLength(1);
  });

  it('refuses an unknown run, a run that has not completed and a run without an eligible pair', async () => {
    const handle = getHandle();
    expect(await startBlindReview(handle, 'run_missing')).toEqual({ status: 'not-found' });

    const running = await seedRun(handle, await seedTargets(handle));
    expect(await startBlindReview(handle, running)).toEqual({ status: 'not-completed' });

    const runId = await completedRun(handle);
    await insertAgentRun(handle, agentRun(runId, { variant: 'baseline' }));
    await insertAgentRun(handle, agentRun(runId, { variant: 'candidate', outputFilesKept: false }));
    expect(await startBlindReview(handle, runId)).toEqual({ status: 'no-eligible-pairs' });
    // The review row of the refused start was rolled back.
    expect(await handle.db.select().from(schema.blindReviews)).toEqual([]);
  });

  it('rethrows an unexpected failure', async () => {
    const handle = getHandle();
    const { runId } = await runWithPairs(handle, [{ caseId: 'case-a', repetition: 1 }]);
    handle.sqlite.exec('drop table blind_review_pairs');
    await expect(startBlindReview(handle, runId)).rejects.toThrow(
      /insert into "blind_review_pairs"/,
    );
    expect(await handle.db.select().from(schema.blindReviews)).toEqual([]);
  });
});

describe('assertBlindPairIntegrity', () => {
  const runs = new Map([
    ['arun_1', { caseId: 'case-a' }],
    ['arun_2', { caseId: 'case-a' }],
    ['arun_3', { caseId: 'case-b' }],
  ]);

  it('accepts two different agent runs of the pair case', () => {
    expect(() =>
      assertBlindPairIntegrity(
        { caseId: 'case-a', aAgentRunId: 'arun_1', bAgentRunId: 'arun_2' },
        runs,
      ),
    ).not.toThrow();
  });

  it.each([
    ['a side of another benchmark run', 'arun_x', 'arun_2'],
    ['b side of another benchmark run', 'arun_1', 'arun_x'],
    ['the same agent run twice', 'arun_1', 'arun_1'],
    ['an a side of another case', 'arun_3', 'arun_2'],
    ['a b side of another case', 'arun_1', 'arun_3'],
  ])('fails on %s', (_name, aAgentRunId, bAgentRunId) => {
    expect(() =>
      assertBlindPairIntegrity({ caseId: 'case-a', aAgentRunId, bAgentRunId }, runs),
    ).toThrow(/two agent runs of one case/);
  });
});

describe('reviewer reads', () => {
  it('return no variant, agent-run id, repetition or status while unrevealed (FR-123-52)', async () => {
    const handle = getHandle();
    const { runId, ids } = await runWithPairs(handle, [
      { caseId: 'case-a', repetition: 1 },
      { caseId: 'case-b', repetition: 2 },
    ]);
    expect(await getBlindReviewForReviewer(handle.db, runId)).toBeNull();
    const { reviewId } = (await startBlindReview(handle, runId)) as { reviewId: string };

    const view = await getBlindReviewForReviewer(handle.db, runId);
    expect(Object.keys(view!).sort()).toEqual(['pairs', 'review']);
    expect(Object.keys(view!.review).sort()).toEqual(['createdAt', 'id', 'revealedAt']);
    expect(view!.review).toMatchObject({ id: reviewId, revealedAt: null });
    expect(view!.pairs.map((p) => p.position)).toEqual([1, 2]);
    for (const pair of view!.pairs) {
      expect(Object.keys(pair).sort()).toEqual([
        'caseId',
        'decidedAt',
        'id',
        'note',
        'position',
        'verdict',
      ]);
    }

    const sides = await Promise.all(
      (['a', 'b'] as const).map((side) =>
        getBlindPairFiles(handle.db, {
          benchmarkRunId: runId,
          position: 1,
          side,
          path: 'shared.txt',
        }),
      ),
    );
    for (const side of sides) {
      expect(Object.keys(side!).sort()).toEqual(['file', 'files']);
      for (const file of [...side!.files, side!.file!]) {
        expect(
          Object.keys(file)
            .filter((key) => key !== 'content')
            .sort(),
        ).toEqual([
          'change',
          'kept',
          'path',
          'reason',
          'redactions',
          'sha256',
          'sizeBytes',
          'storedBytes',
        ]);
      }
    }
    const serialised = JSON.stringify([view, sides]);
    for (const id of ids.values()) expect(serialised).not.toContain(id);
    // Each side has its own files: one baseline.txt, one candidate.txt, so they differ.
    expect(sides.map((s) => s!.files.map((f) => f.path))).toEqual(
      expect.arrayContaining([
        ['baseline.txt', 'shared.txt'],
        ['candidate.txt', 'shared.txt'],
      ]),
    );
    expect(sides.map((s) => s!.file!.content).sort()).toEqual(['baseline text', 'candidate text']);
  });

  it('leaves artifact-path entries out and loads content only for a listed path', async () => {
    const handle = getHandle();
    const runId = await completedRun(handle);
    for (const variant of ['baseline', 'candidate'] as const) {
      await insertAgentRun(
        handle,
        agentRun(runId, {
          variant,
          outputFiles: [
            outputFile('.claude/skills/x/SKILL.md', {
              kept: 'none',
              reason: 'artifact-path',
              content: null,
            }),
            outputFile('gone.txt', {
              change: 'deleted',
              kept: 'none',
              reason: 'deleted',
              content: null,
              sizeBytes: null,
              sha256: null,
              storedBytes: 0,
            }),
            outputFile('out.txt'),
          ],
        }),
      );
    }
    await startBlindReview(handle, runId);
    const at = (side: 'a' | 'b', path: string | null, position = 1) =>
      getBlindPairFiles(handle.db, { benchmarkRunId: runId, position, side, path });

    const listed = await at('b', null);
    expect(listed!.files.map((f) => [f.path, f.reason])).toEqual([
      ['gone.txt', 'deleted'],
      ['out.txt', null],
    ]);
    expect(listed!.file).toBeNull();
    expect((await at('a', 'out.txt'))!.file).toMatchObject({
      path: 'out.txt',
      content: 'content of out.txt',
    });
    expect((await at('a', 'gone.txt'))!.file).toMatchObject({ change: 'deleted', content: null });
    expect((await at('a', '.claude/skills/x/SKILL.md'))!.file).toBeNull();
    expect((await at('a', 'missing.txt'))!.file).toBeNull();
    expect(await at('a', 'out.txt', 2)).toBeNull();
    expect(
      await getBlindPairFiles(handle.db, {
        benchmarkRunId: 'run_other',
        position: 1,
        side: 'a',
        path: null,
      }),
    ).toBeNull();
  });
});

describe('verdict and reveal', () => {
  async function startedReview(handle: DatabaseHandle) {
    const { runId, ids } = await runWithPairs(handle, [
      { caseId: 'case-a', repetition: 1 },
      { caseId: 'case-a', repetition: 2 },
      { caseId: 'case-b', repetition: 1 },
      { caseId: 'case-b', repetition: 2 },
    ]);
    const { reviewId } = (await startBlindReview(handle, runId)) as { reviewId: string };
    const { pairs } = (await getBlindReviewForReviewer(handle.db, runId))!;
    return { runId, ids, reviewId, pairs };
  }

  it('records one immutable verdict per pair, also against a concurrent second call (FR-123-53)', async () => {
    const handle = getHandle();
    const { runId, pairs } = await startedReview(handle);
    const pairId = pairs[0]!.id;
    const outcomes = await Promise.all([
      recordBlindVerdict(handle.db, {
        benchmarkRunId: runId,
        pairId,
        verdict: 'a',
        note: 'clearer',
      }),
      recordBlindVerdict(handle.db, { benchmarkRunId: runId, pairId, verdict: 'b', note: null }),
    ]);
    expect(outcomes).toEqual(['recorded', 'already-decided']);
    const [stored] = (await getBlindReviewForReviewer(handle.db, runId))!.pairs;
    expect(stored).toMatchObject({ verdict: 'a', note: 'clearer', decidedAt: expect.any(String) });
    expect(
      await recordBlindVerdict(handle.db, {
        benchmarkRunId: runId,
        pairId: 'bpair_missing',
        verdict: 'tie',
        note: null,
      }),
    ).toBe('not-found');
  });

  it('reveals all pairs once and closes verdicts afterwards (FR-123-54, A9)', async () => {
    const handle = getHandle();
    const { runId, reviewId, pairs } = await startedReview(handle);
    expect(await hasUnrevealedBlindReview(handle.db, runId)).toBe(true);
    expect(await getBlindReviewResult(handle.db, runId)).toBeNull();

    expect(
      await Promise.all([
        revealBlindReview(handle.db, { benchmarkRunId: runId, reviewId }),
        revealBlindReview(handle.db, { benchmarkRunId: runId, reviewId }),
      ]),
    ).toEqual(['revealed', 'already-revealed']);
    expect(
      await revealBlindReview(handle.db, { benchmarkRunId: runId, reviewId: 'brev_missing' }),
    ).toBe('not-found');
    expect(await hasUnrevealedBlindReview(handle.db, runId)).toBe(false);
    expect(
      await recordBlindVerdict(handle.db, {
        benchmarkRunId: runId,
        pairId: pairs[0]!.id,
        verdict: 'a',
        note: null,
      }),
    ).toBe('revealed');
    expect((await getBlindReviewForReviewer(handle.db, runId))!.review.revealedAt).toEqual(
      expect.any(String),
    );
  });

  it('names each side after the reveal and summarises the verdicts by variant without touching scores', async () => {
    const handle = getHandle();
    const { runId, ids, reviewId, pairs } = await startedReview(handle);
    const rows = await handle.db.select().from(schema.blindReviewPairs);
    const variantOf = (id: string) => [...ids].find(([, v]) => v === id)![0].split('/')[2];
    // Pair 1: prefer the candidate side; pair 2: prefer the baseline side; pair 3: tie; 4: none.
    const sideOf = (position: number, variant: string) => {
      const row = rows.find((r) => r.position === position)!;
      return variantOf(row.aAgentRunId) === variant ? 'a' : 'b';
    };
    await recordBlindVerdict(handle.db, {
      benchmarkRunId: runId,
      pairId: pairs[0]!.id,
      verdict: sideOf(1, 'candidate'),
      note: null,
    });
    await recordBlindVerdict(handle.db, {
      benchmarkRunId: runId,
      pairId: pairs[1]!.id,
      verdict: sideOf(2, 'baseline'),
      note: 'n',
    });
    await recordBlindVerdict(handle.db, {
      benchmarkRunId: runId,
      pairId: pairs[2]!.id,
      verdict: 'tie',
      note: null,
    });
    const before = await handle.db.select().from(schema.agentRuns);
    await revealBlindReview(handle.db, { benchmarkRunId: runId, reviewId });

    const result = (await getBlindReviewResult(handle.db, runId))!;
    expect(result).toMatchObject({ reviewId, revealedAt: expect.any(String) });
    expect(result.summary).toEqual({ pairs: 4, candidate: 1, baseline: 1, tie: 1, none: 1 });
    expect(result.pairs.map((p) => p.verdict)).toEqual([
      sideOf(1, 'candidate'),
      sideOf(2, 'baseline'),
      'tie',
      null,
    ]);
    for (const pair of result.pairs) {
      const row = rows.find((r) => r.position === pair.position)!;
      expect(pair.a).toEqual({
        agentRunId: row.aAgentRunId,
        variant: variantOf(row.aAgentRunId),
        repetition: expect.any(Number),
      });
      expect(pair.b.agentRunId).toBe(row.bAgentRunId);
      expect(pair.a.variant).not.toBe(pair.b.variant);
      expect(pair.a.repetition).toBe(pair.b.repetition);
    }
    expect(result.pairs[1]!.note).toBe('n');
    // Scores, pass/fail and statuses of the agent runs are untouched (§4).
    expect(await handle.db.select().from(schema.agentRuns)).toEqual(before);
  });

  it('refuses a verdict or a reveal for a pair or review of another run and changes nothing (issue #170)', async () => {
    const handle = getHandle();
    const own = await startedReview(handle);
    const other = await startedReview(handle);
    const before = {
      reviews: await handle.db.select().from(schema.blindReviews),
      pairs: await handle.db.select().from(schema.blindReviewPairs),
    };
    expect(
      await recordBlindVerdict(handle.db, {
        benchmarkRunId: own.runId,
        pairId: other.pairs[0]!.id,
        verdict: 'a',
        note: 'forged',
      }),
    ).toBe('other-run');
    expect(
      await revealBlindReview(handle.db, { benchmarkRunId: own.runId, reviewId: other.reviewId }),
    ).toBe('other-run');
    expect(
      await recordBlindVerdict(handle.db, {
        benchmarkRunId: 'run_missing',
        pairId: own.pairs[0]!.id,
        verdict: 'tie',
        note: null,
      }),
    ).toBe('other-run');
    expect(
      await revealBlindReview(handle.db, { benchmarkRunId: 'run_missing', reviewId: own.reviewId }),
    ).toBe('other-run');
    expect(await handle.db.select().from(schema.blindReviews)).toEqual(before.reviews);
    expect(await handle.db.select().from(schema.blindReviewPairs)).toEqual(before.pairs);

    // A mismatch is refused before a decided pair or a revealed review is reported.
    await recordBlindVerdict(handle.db, {
      benchmarkRunId: other.runId,
      pairId: other.pairs[0]!.id,
      verdict: 'b',
      note: null,
    });
    await revealBlindReview(handle.db, { benchmarkRunId: other.runId, reviewId: other.reviewId });
    expect(
      await recordBlindVerdict(handle.db, {
        benchmarkRunId: own.runId,
        pairId: other.pairs[0]!.id,
        verdict: 'a',
        note: null,
      }),
    ).toBe('other-run');
    expect(
      await revealBlindReview(handle.db, { benchmarkRunId: own.runId, reviewId: other.reviewId }),
    ).toBe('other-run');
  });

  it('returns no result for a run without a review', async () => {
    expect(await getBlindReviewResult(getHandle().db, 'run_missing')).toBeNull();
    expect(await hasUnrevealedBlindReview(getHandle().db, 'run_missing')).toBe(false);
  });

  it('goes with its benchmark run through the cascade (AC-8)', async () => {
    const handle = getHandle();
    const { runId } = await startedReview(handle);
    await handle.db.delete(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.id, runId));
    expect(await handle.db.select().from(schema.blindReviews)).toEqual([]);
    expect(await handle.db.select().from(schema.blindReviewPairs)).toEqual([]);
  });
});
