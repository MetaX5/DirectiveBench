import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgentAdapter, createExecutableAdapters } from '@directivebench/agent-adapters';
import {
  enqueueBenchmarkJob,
  getBenchmarkRunDetail,
  getJob,
  listArtifacts,
  migrateDatabase,
  openDatabase,
  requestJobCancellation,
  seedPredefinedCategories,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner, importBundledExample } from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const examples = fileURLToPath(new URL('../../../examples', import.meta.url));

let handle: DatabaseHandle;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-runner-'));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  await seedPredefinedCategories(handle.db);
});

afterEach(() => handle.close());

function createRunner() {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    adapters: createExecutableAdapters(),
    workspaceRoot: join(dataDir, 'workspaces'),
  });
}

describe('vertical slice: import → enqueue → run → persist', () => {
  it('runs the bundled mock benchmark and persists comparable RED/GREEN results', async () => {
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    expect(example.artifact.createdVersion).toBe(true);
    const again = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    expect(again.suite.versionId).toBe(example.suite.versionId);
    expect(again.artifact.versionId).toBe(example.artifact.versionId);

    const job = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const results = await createRunner().runUntilIdle();
    expect(results).toEqual([
      expect.objectContaining({ jobId: job.id, status: 'completed', error: null }),
    ]);

    const runId = results[0]?.benchmarkRunId as string;
    const detail = await getBenchmarkRunDetail(handle.db, runId);
    expect(detail?.run).toMatchObject({
      status: 'completed',
      verdict: 'improved',
      agentAdapterId: 'mock',
    });
    expect(detail?.run.summary).toMatchObject({ delta: 0.5, displayStatus: 'passed' });
    expect(detail?.agentRuns).toHaveLength(6);
    expect(detail?.agentRuns.flatMap((r) => r.assertions)).toHaveLength(24);

    const listed = await listArtifacts(handle.db);
    expect(listed[0]?.latestEvaluation).toMatchObject({
      verdict: 'improved',
      delta: 0.5,
      candidateScore: 1,
      baselineScore: 0.5,
    });
    expect(listed[0]?.categories.map((c) => c.slug)).toEqual(['code-quality', 'security']);
  }, 60_000);

  it('does not run commands of unapproved suites', async () => {
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    handle.sqlite.exec('update benchmark_suite_versions set execution_approved_at = null');
    await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const [result] = await createRunner().runUntilIdle();
    expect(result).toMatchObject({ status: 'failed' });
    expect(result?.error).toMatch(/not been approved/);
  });

  it('honours cancellation of pending jobs and recovers orphaned running jobs', async () => {
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const payload = {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    };
    const cancelled = await enqueueBenchmarkJob(handle.db, payload);
    await requestJobCancellation(handle.db, cancelled.id);

    const orphan = await enqueueBenchmarkJob(handle.db, payload);
    handle.sqlite
      .prepare(
        "update jobs set status = 'running', heartbeat_at = '2000-01-01T00:00:00.000Z' where id = ?",
      )
      .run(orphan.id);

    const runner = createRunner();
    expect(await runner.recover()).toEqual([orphan.id]);
    expect(await runner.runUntilIdle()).toEqual([]);
    expect((await getJob(handle.db, cancelled.id))?.status).toBe('cancelled');
    expect((await getJob(handle.db, orphan.id))?.status).toBe('interrupted');
  });

  it('marks running jobs as interrupted on graceful shutdown', async () => {
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const job = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const runner = createRunner();
    await runner.poll();
    expect(runner.activeJobCount).toBe(1);
    await runner.stop();
    expect((await getJob(handle.db, job.id))?.status).toBe('interrupted');
  }, 60_000);
});

describe('runner lifecycle details', () => {
  it('uses a runner id of the form local-<hostname>-<pid>-<random> (FR-114-17)', () => {
    expect(createRunner().runnerId).toMatch(new RegExp(`^local-.+-${process.pid}-[0-9a-f]{8}$`));
  });

  it('caps graceful shutdown and marks jobs that do not stop as interrupted (FR-114-13)', async () => {
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const job = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    // An adapter that ignores cancellation for longer than the shutdown cap.
    const stubborn = new MockAgentAdapter();
    stubborn.run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        status: 'completed',
        durationMs: 1500,
        summary: '',
        trace: [],
        usage: null,
        error: null,
      };
    };
    const runner = new LocalRunner({
      handle,
      fixtureStore: join(dataDir, 'fixtures'),
      adapters: new Map([['mock', stubborn]]),
      workspaceRoot: join(dataDir, 'workspaces'),
      shutdownTimeoutMs: 200,
    });
    await runner.poll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await runner.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await getJob(handle.db, job.id))?.status).toBe('interrupted');
    // Let the abandoned execution settle before the database is closed.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30_000);
});
