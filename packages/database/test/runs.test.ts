import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countRunsByVerdict,
  finishBenchmarkRun,
  getBenchmarkRunDetail,
  importSuiteVersion,
  insertAgentRun,
  listBenchmarkRuns,
  schema,
  type AgentRunInput,
  type FinishBenchmarkRunInput,
} from '../src/index';
import { seedRun, seedTargets, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

afterEach(() => {
  vi.useRealTimers();
});

function agentRunInput(
  benchmarkRunId: string,
  overrides: Partial<AgentRunInput> = {},
): AgentRunInput {
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
    changedFiles: [{ path: 'a.txt', change: 'added' }],
    trace: [{ type: 'message' }],
    usage: { inputTokens: 1 },
    error: null,
    assertions: [],
    ...overrides,
  };
}

const assertion = {
  assertionId: 'file-exists',
  type: 'file-exists',
  passed: true,
  score: 1,
  weight: 1,
  required: true,
  deterministic: true,
  message: 'ok',
  details: { path: 'a.txt' },
};

function finished(overrides: Partial<FinishBenchmarkRunInput> = {}): FinishBenchmarkRunInput {
  return {
    status: 'completed',
    verdict: null,
    summary: null,
    comparabilityKey: null,
    warnings: [],
    error: null,
    ...overrides,
  };
}

describe('createBenchmarkRun and finishBenchmarkRun', () => {
  it('starts a run as running and records the final outcome', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const runId = await seedRun(handle, targets, {
      agentVersion: '1.2.3',
      model: { provider: 'mock', model: 'm' },
      environment: { os: 'linux' },
    });

    const started = await getBenchmarkRunDetail(handle.db, runId);
    expect(started?.run).toMatchObject({
      status: 'running',
      startedAt: '2026-03-01T00:00:00.000Z',
      finishedAt: null,
      agentVersion: '1.2.3',
      model: { provider: 'mock', model: 'm' },
      environment: { os: 'linux' },
      warnings: [],
    });
    expect(started?.agentRuns).toEqual([]);
    expect(started?.suite.id).toBe(targets.suiteId);
    expect(started?.artifact.id).toBe(targets.artifactId);

    vi.setSystemTime(new Date('2026-03-01T00:05:00.000Z'));
    await finishBenchmarkRun(
      handle.db,
      runId,
      finished({
        verdict: 'improved',
        summary: { delta: 1 },
        comparabilityKey: 'k',
        warnings: ['w'],
      }),
    );
    const done = await getBenchmarkRunDetail(handle.db, runId);
    expect(done?.run).toMatchObject({
      status: 'completed',
      verdict: 'improved',
      summary: { delta: 1 },
      comparabilityKey: 'k',
      warnings: ['w'],
      finishedAt: '2026-03-01T00:05:00.000Z',
    });
  });
});

describe('insertAgentRun', () => {
  it('stores agent runs with their assertions, ordered by case, repetition and variant', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    const candidate = await insertAgentRun(
      handle,
      agentRunInput(runId, { variant: 'candidate', assertions: [assertion] }),
    );
    const baseline = await insertAgentRun(
      handle,
      agentRunInput(runId, {
        score: null,
        passed: null,
        usage: null,
        executionStatus: 'timeout',
        error: 'timed out',
        assertions: [assertion, { ...assertion, assertionId: 'second', passed: false }],
      }),
    );
    const later = await insertAgentRun(handle, agentRunInput(runId, { caseId: 'case-b' }));

    const detail = await getBenchmarkRunDetail(handle.db, runId);
    expect(detail?.agentRuns.map((r) => r.id)).toEqual([baseline, candidate, later]);
    expect(detail?.agentRuns[0]).toMatchObject({
      score: null,
      passed: null,
      usage: null,
      executionStatus: 'timeout',
      error: 'timed out',
    });
    expect(detail?.agentRuns[0]?.assertions.map((a) => [a.assertionId, a.passed])).toEqual([
      ['file-exists', true],
      ['second', false],
    ]);
    expect(detail?.agentRuns[1]?.assertions).toEqual([
      { ...assertion, id: expect.any(String), agentRunId: candidate },
    ]);
    expect(detail?.agentRuns[2]?.assertions).toEqual([]);
  });

  it('stores nothing when an assertion cannot be saved', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    // Simulates a corrupt result from the engine: `message` is NOT NULL in the schema.
    const broken = { ...assertion, message: null as unknown as string };
    await expect(
      insertAgentRun(handle, agentRunInput(runId, { assertions: [assertion, broken] })),
    ).rejects.toThrow();
    expect(await handle.db.select().from(schema.agentRuns)).toEqual([]);
    expect(await handle.db.select().from(schema.assertionResults)).toEqual([]);
  });
});

describe('getBenchmarkRunDetail', () => {
  it('returns null for an unknown run', async () => {
    expect(await getBenchmarkRunDetail(getHandle().db, 'run_missing')).toBeNull();
  });
});

describe('listBenchmarkRuns', () => {
  it('lists newest runs first with suite and artifact labels, optionally per suite', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const other = await importSuiteVersion(
      handle,
      suiteInput('o1', { slug: 'other', name: 'Other' }),
    );

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = await seedRun(handle, targets);
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const second = await seedRun(handle, { ...targets, suiteVersionId: other.versionId });
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    const third = await seedRun(handle, targets);

    const all = await listBenchmarkRuns(handle.db);
    expect(all.map((r) => r.run.id)).toEqual([third, second, first]);
    expect(all[1]).toMatchObject({
      suite: { id: other.suiteId, name: 'Other', version: 1 },
      artifact: { id: targets.artifactId, name: 'validate', version: 1 },
    });

    expect((await listBenchmarkRuns(handle.db, { limit: 1 })).map((r) => r.run.id)).toEqual([
      third,
    ]);
    const forSuite = await listBenchmarkRuns(handle.db, { suiteId: targets.suiteId });
    expect(forSuite.map((r) => r.run.id)).toEqual([third, first]);
    expect(await listBenchmarkRuns(handle.db, { suiteId: 'suite_missing' })).toEqual([]);
  });
});

describe('countRunsByVerdict', () => {
  it('counts finished runs by verdict and the rest by status', async () => {
    const handle = getHandle();
    expect(await countRunsByVerdict(handle.db)).toEqual({});

    const targets = await seedTargets(handle);
    const ids = await Promise.all(Array.from({ length: 5 }, () => seedRun(handle, targets)));
    const [improved, improvedWithError, errored, cancelled] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    await finishBenchmarkRun(handle.db, improved, finished({ verdict: 'improved' }));
    await finishBenchmarkRun(
      handle.db,
      improvedWithError,
      finished({ status: 'error', verdict: 'improved' }),
    );
    await finishBenchmarkRun(handle.db, errored, finished({ status: 'error', error: 'x' }));
    await finishBenchmarkRun(handle.db, cancelled, finished({ status: 'cancelled' }));

    expect(await countRunsByVerdict(handle.db)).toEqual({
      improved: 2,
      error: 1,
      cancelled: 1,
      running: 1,
    });
  });
});
