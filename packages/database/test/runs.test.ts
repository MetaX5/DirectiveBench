import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countRunsByVerdict,
  importArtifactVersion,
  finishBenchmarkRun,
  getBenchmarkRunDetail,
  importSuiteVersion,
  insertAgentRun,
  getAgentRunFile,
  listAgentRunFiles,
  ARTIFACT_RUNS_PAGE_LIMIT,
  ARTIFACT_VERSION_COMPARISON_LIMIT,
  countArtifactRuns,
  listArtifactRuns,
  listVersionComparisonRuns,
  listBenchmarkRuns,
  schema,
  type AgentRunFileInput,
  type AgentRunInput,
  type FinishBenchmarkRunInput,
} from '../src/index';
import { artifactInput, seedRun, seedTargets, suiteInput } from './support/fixtures';
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
    outputFilesKept: false,
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
    content: 'hello',
    storedBytes: 5,
    redactions: 0,
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
      baselineArtifactVersionId: null,
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

describe('A/B baseline on a run (SPEC-118 FR-118-13)', () => {
  it('stores the baseline version and returns it with the run', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));
    expect(v2.artifactId).toBe(targets.artifactId);
    const runId = await seedRun(
      handle,
      { ...targets, artifactVersionId: v2.versionId },
      { baselineArtifactVersionId: targets.artifactVersionId },
    );
    const detail = await getBenchmarkRunDetail(handle.db, runId);
    expect(detail?.run).toMatchObject({
      artifactVersionId: v2.versionId,
      baselineArtifactVersionId: targets.artifactVersionId,
    });
    expect(detail?.artifactVersion.version).toBe(2);
    expect(detail?.baselineArtifactVersion).toEqual({
      id: targets.artifactVersionId,
      version: 1,
      contentHash: expect.any(String),
    });
    const [listed] = await listBenchmarkRuns(handle.db);
    expect(listed?.run.baselineArtifactVersionId).toBe(targets.artifactVersionId);
  });

  it('refuses a baseline id that is not an artifact version', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    await expect(
      seedRun(handle, targets, { baselineArtifactVersionId: 'artv_missing' }),
    ).rejects.toThrow();
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

describe('agent run output files (SPEC-123 FR-123-11, §8.3)', () => {
  it('stores the files with the agent run and the kept flag, and reads them back', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    const truncated = outputFile('src/big.txt', {
      kept: 'truncated',
      reason: 'file-limit',
      sizeBytes: 2_000_000,
      content: 'x[REDACTED]',
      storedBytes: 11,
      redactions: 1,
    });
    const deleted = outputFile('old.txt', {
      change: 'deleted',
      sizeBytes: null,
      sha256: null,
      kept: 'none',
      reason: 'deleted',
      content: null,
      storedBytes: 0,
    });
    const agentRunId = await insertAgentRun(
      handle,
      agentRunInput(runId, {
        outputFilesKept: true,
        outputFiles: [truncated, outputFile('a.txt'), deleted],
      }),
    );
    const notKept = await insertAgentRun(
      handle,
      agentRunInput(runId, {
        caseId: 'case-b',
        outputFilesReason: 'a file changed after the agent stopped: a.txt',
      }),
    );

    const detail = await getBenchmarkRunDetail(handle.db, runId);
    expect(detail?.agentRuns.map((r) => [r.id, r.outputFilesKept, r.outputFilesReason])).toEqual([
      [agentRunId, true, null],
      [notKept, false, 'a file changed after the agent stopped: a.txt'],
    ]);

    const listed = await listAgentRunFiles(handle.db, agentRunId);
    expect(listed.map((f) => f.path)).toEqual(['a.txt', 'old.txt', 'src/big.txt']);
    // Metadata only: the listing never carries content.
    for (const file of listed) expect(Object.keys(file)).not.toContain('content');
    expect(listed[2]).toEqual({
      ...truncated,
      content: undefined,
      id: expect.stringMatching(/^afile_/),
      agentRunId,
    });
    expect(await listAgentRunFiles(handle.db, notKept)).toEqual([]);

    expect(
      await getAgentRunFile(handle.db, { benchmarkRunId: runId, agentRunId, path: 'src/big.txt' }),
    ).toEqual({ ...truncated, id: listed[2]?.id, agentRunId });
    expect(
      await getAgentRunFile(handle.db, { benchmarkRunId: runId, agentRunId, path: 'missing' }),
    ).toBeNull();
  });

  it('serves a file only through the benchmark run its agent run belongs to', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const runId = await seedRun(handle, targets);
    const otherRun = await seedRun(handle, targets);
    const agentRunId = await insertAgentRun(
      handle,
      agentRunInput(runId, { outputFilesKept: true, outputFiles: [outputFile('a.txt')] }),
    );
    expect(
      await getAgentRunFile(handle.db, { benchmarkRunId: otherRun, agentRunId, path: 'a.txt' }),
    ).toBeNull();
  });

  it('stores neither the agent run nor any file when one file cannot be saved', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    // Two files with one path violate the unique (agent_run_id, path) index.
    await expect(
      insertAgentRun(
        handle,
        agentRunInput(runId, {
          outputFilesKept: true,
          outputFiles: [outputFile('a.txt'), outputFile('a.txt')],
        }),
      ),
    ).rejects.toThrow();
    expect(await handle.db.select().from(schema.agentRuns)).toEqual([]);
    expect(await handle.db.select().from(schema.agentRunFiles)).toEqual([]);
  });

  it('removes the files with their benchmark run (cascade, AC-8)', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    await insertAgentRun(
      handle,
      agentRunInput(runId, { outputFilesKept: true, outputFiles: [outputFile('a.txt')] }),
    );
    expect(await handle.db.$count(schema.agentRunFiles)).toBe(1);
    handle.sqlite.prepare('delete from benchmark_runs where id = ?').run(runId);
    expect(await handle.db.$count(schema.agentRuns)).toBe(0);
    expect(await handle.db.$count(schema.agentRunFiles)).toBe(0);
  });
});

describe('getBenchmarkRunDetail', () => {
  it('returns null for an unknown run', async () => {
    expect(await getBenchmarkRunDetail(getHandle().db, 'run_missing')).toBeNull();
  });

  it('returns no baseline version for baseline kind none', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    expect((await getBenchmarkRunDetail(handle.db, runId))?.baselineArtifactVersion).toBeNull();
  });
});

describe('listArtifactRuns (SPEC-118 FR-118-50)', () => {
  it('lists one artifact’s runs newest version first, then newest run first, with baselines', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const targets = await seedTargets(handle);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));
    const other = await importArtifactVersion(
      handle,
      artifactInput('other', { slug: 'other', path: 'skills/other' }),
    );
    const v1Run = await seedRun(handle, targets);
    vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'));
    const v2None = await seedRun(handle, { ...targets, artifactVersionId: v2.versionId });
    vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));
    const v2Ab = await seedRun(
      handle,
      { ...targets, artifactVersionId: v2.versionId },
      { baselineArtifactVersionId: targets.artifactVersionId, agentAdapterId: 'claude-code' },
    );
    // Same start time as v2Ab: the id decides, never the storage order.
    const v2Tie = await seedRun(handle, { ...targets, artifactVersionId: v2.versionId });
    await seedRun(handle, { ...targets, artifactVersionId: other.versionId });
    await finishBenchmarkRun(handle.db, v2Ab, finished({ verdict: 'improved' }));

    const runs = await listArtifactRuns(handle.db, targets.artifactId);
    const tied = [v2Ab, v2Tie].sort().reverse();
    expect(runs.map((r) => r.run.id)).toEqual([...tied, v2None, v1Run]);
    const ab = runs.find((r) => r.run.id === v2Ab);
    expect(ab).toEqual({
      run: expect.objectContaining({
        id: v2Ab,
        status: 'completed',
        verdict: 'improved',
        agentAdapterId: 'claude-code',
      }),
      suite: { id: targets.suiteId, name: 'Suite', version: 1 },
      artifactVersion: { id: v2.versionId, version: 2 },
      baselineVersion: { id: targets.artifactVersionId, version: 1 },
    });
    expect(runs.find((r) => r.run.id === v1Run)).toMatchObject({
      artifactVersion: { id: targets.artifactVersionId, version: 1 },
      baselineVersion: null,
    });
    expect(await listArtifactRuns(handle.db, 'art_missing')).toEqual([]);
  });
});

const fullSummary = {
  delta: 0.25,
  verdict: 'improved',
  candidateOutcome: 'passed',
  candidate: { meanScore: 0.75, validRuns: 2, stdDev: 0.1 },
  baseline: { meanScore: 0.5 },
  confidence: { level: 'low', reason: 'one repetition' },
  scoring: { minDelta: 0.05, passThreshold: 1 },
  environment: { kind: 'local-process', agentProfile: { authMode: 'api-key' } },
  cases: [{ caseId: 'a', delta: 0.25 }],
  reasons: ['x'.repeat(1000)],
};

/** Inserts `count` runs in one statement; ids and start times sort in insertion order. */
async function bulkRuns(
  handle: ReturnType<typeof getHandle>,
  rows: {
    versionId: string;
    suiteVersionId: string;
    key?: (i: number) => string | null;
    summary?: Record<string, unknown> | null;
    verdict?: string | null;
    status?: 'completed' | 'running';
  }[],
): Promise<void> {
  const values = rows.map((row, i) => ({
    id: `run_bulk_${String(i).padStart(6, '0')}`,
    jobId: null,
    suiteVersionId: row.suiteVersionId,
    artifactVersionId: row.versionId,
    baselineArtifactVersionId: null,
    agentAdapterId: 'mock',
    agentVersion: null,
    model: null,
    environment: {},
    status: row.status ?? ('completed' as const),
    verdict: row.verdict === undefined ? 'improved' : row.verdict,
    summary: row.summary === undefined ? fullSummary : row.summary,
    comparabilityKey: row.key ? row.key(i) : 'key',
    warnings: [],
    error: null,
    startedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    finishedAt: null,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await handle.db.insert(schema.benchmarkRuns).values(values.slice(i, i + 500));
  }
}

describe('listArtifactRuns bound and projection (Codex review of PR #112)', () => {
  it('loads at most ARTIFACT_RUNS_PAGE_LIMIT runs, newest first, and counts them all', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const total = ARTIFACT_RUNS_PAGE_LIMIT + 5;
    await bulkRuns(
      handle,
      Array.from({ length: total }, () => ({
        versionId: targets.artifactVersionId,
        suiteVersionId: targets.suiteVersionId,
      })),
    );
    const runs = await listArtifactRuns(handle.db, targets.artifactId);
    expect(runs).toHaveLength(ARTIFACT_RUNS_PAGE_LIMIT);
    expect(runs[0]?.run.id).toBe(`run_bulk_${String(total - 1).padStart(6, '0')}`);
    expect(runs.at(-1)?.run.id).toBe('run_bulk_000005');
    expect(await countArtifactRuns(handle.db, targets.artifactId)).toBe(total);
    expect(await countArtifactRuns(handle.db, 'art_missing')).toBe(0);
  });

  it('returns only the summary fields the page renders, never traces, cases or reasons', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const runId = await seedRun(handle, targets);
    const bare = await seedRun(handle, targets);
    await finishBenchmarkRun(handle.db, runId, finished({ summary: fullSummary, warnings: ['w'] }));
    await finishBenchmarkRun(handle.db, bare, finished({ summary: { verdict: 'error' } }));
    const runs = await listArtifactRuns(handle.db, targets.artifactId);
    const full = runs.find((r) => r.run.id === runId);
    expect(Object.keys(full?.run ?? {}).sort()).toEqual([
      'agentAdapterId',
      'agentVersion',
      'comparabilityKey',
      'id',
      'model',
      'startedAt',
      'status',
      'summary',
      'verdict',
      'warnings',
    ]);
    expect(full?.run.warnings).toEqual(['w']);
    expect(full?.run.summary).toEqual({
      delta: 0.25,
      verdict: 'improved',
      candidateOutcome: 'passed',
      candidate: { meanScore: 0.75 },
      confidence: { level: 'low' },
      scoring: { minDelta: 0.05 },
      environment: { agentProfile: { authMode: 'api-key' } },
    });
    expect(runs.find((r) => r.run.id === bare)?.run.summary).toEqual({
      delta: null,
      verdict: 'error',
      candidateOutcome: null,
      candidate: { meanScore: null },
      confidence: { level: null },
      scoring: { minDelta: null },
      environment: { agentProfile: null },
    });
    const running = await seedRun(handle, targets);
    expect(
      (await listArtifactRuns(handle.db, targets.artifactId)).find((r) => r.run.id === running)?.run
        .summary,
    ).toBeNull();
  });
});

describe('listVersionComparisonRuns (SPEC-111 FR-111-50, Codex review of PR #112)', () => {
  it('returns the latest eligible run per version and comparability key, outside any page window', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));
    const base = { suiteVersionId: targets.suiteVersionId };
    await bulkRuns(handle, [
      // v1, key a: the older run is the only one; v1 also has a key without an eligible run.
      { ...base, versionId: targets.artifactVersionId, key: () => 'a' },
      { ...base, versionId: targets.artifactVersionId, key: () => 'b', verdict: 'error' },
      { ...base, versionId: targets.artifactVersionId, key: () => 'b', verdict: 'not-comparable' },
      { ...base, versionId: targets.artifactVersionId, key: () => null },
      {
        ...base,
        versionId: targets.artifactVersionId,
        key: () => 'b',
        status: 'running',
        summary: null,
        verdict: null,
      },
      { ...base, versionId: targets.artifactVersionId, key: () => 'b', summary: { candidate: {} } },
      {
        ...base,
        versionId: targets.artifactVersionId,
        key: () => 'b',
        summary: { scoring: { minDelta: 0.05 } },
      },
      // v2, key a: two runs, the later one wins; after them hundreds of newer runs of key c.
      {
        ...base,
        versionId: v2.versionId,
        key: () => 'a',
        summary: { ...fullSummary, candidateOutcome: 'failed' },
      },
      {
        ...base,
        versionId: v2.versionId,
        key: () => 'a',
        verdict: 'unstable',
        summary: { ...fullSummary, candidate: { meanScore: null } },
      },
      ...Array.from({ length: ARTIFACT_RUNS_PAGE_LIMIT + 1 }, () => ({
        ...base,
        versionId: v2.versionId,
        key: () => 'c',
      })),
    ]);
    const window = await listArtifactRuns(handle.db, targets.artifactId);
    expect(window.some((r) => r.run.comparabilityKey === 'a')).toBe(false);

    const { runs, truncated } = await listVersionComparisonRuns(handle.db, targets.artifactId);
    expect(truncated).toBe(false);
    expect(runs).toEqual([
      {
        runId: 'run_bulk_000008',
        artifactVersionId: v2.versionId,
        version: 2,
        comparabilityKey: 'a',
        verdict: 'unstable',
        agentAdapterId: 'mock',
        candidateMeanScore: null,
        candidateOutcome: 'passed',
        minDelta: 0.05,
      },
      {
        runId: `run_bulk_${String(9 + ARTIFACT_RUNS_PAGE_LIMIT).padStart(6, '0')}`,
        artifactVersionId: v2.versionId,
        version: 2,
        comparabilityKey: 'c',
        verdict: 'improved',
        agentAdapterId: 'mock',
        candidateMeanScore: 0.75,
        candidateOutcome: 'passed',
        minDelta: 0.05,
      },
      {
        runId: 'run_bulk_000000',
        artifactVersionId: targets.artifactVersionId,
        version: 1,
        comparabilityKey: 'a',
        verdict: 'improved',
        agentAdapterId: 'mock',
        candidateMeanScore: 0.75,
        candidateOutcome: 'passed',
        minDelta: 0.05,
      },
    ]);
  });

  it('loads at most ARTIFACT_VERSION_COMPARISON_LIMIT pairs, newest version first', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));
    const base = { suiteVersionId: targets.suiteVersionId };
    await bulkRuns(handle, [
      { ...base, versionId: targets.artifactVersionId, key: () => 'old' },
      ...Array.from({ length: ARTIFACT_VERSION_COMPARISON_LIMIT }, () => ({
        ...base,
        versionId: v2.versionId,
        key: (i: number) => `k${String(i).padStart(6, '0')}`,
      })),
    ]);
    const { runs, truncated } = await listVersionComparisonRuns(handle.db, targets.artifactId);
    expect(truncated).toBe(true);
    expect(runs).toHaveLength(ARTIFACT_VERSION_COMPARISON_LIMIT);
    expect(runs.every((r) => r.version === 2)).toBe(true);
    expect((await listVersionComparisonRuns(handle.db, 'art_missing')).runs).toEqual([]);
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
