import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MockAgentAdapter,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRunResult,
} from '@directivebench/agent-adapters';
import { loadLocalArtifact, nowIso, sha256 } from '@directivebench/core';
import {
  createAcquiredBenchmarkJob,
  enqueueBenchmarkJob,
  getBenchmarkRunDetail,
  getJob,
  importArtifactVersion,
  migrateDatabase,
  openDatabase,
  requestJobCancellation,
  schema,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  JobNotAcquiredError,
  LocalRunner,
  importBundledExample,
  type ExampleImportResult,
  type LocalRunnerOptions,
  type RunnerLogFields,
} from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const examples = fileURLToPath(new URL('../../../examples', import.meta.url));

/** The bundled mock example's comparability key before SPEC-118 (see benchmark-engine tests). */
const MOCK_EXAMPLE_KEY = '8212a3ebe5818fbf2413bfd7671874710a362f4f5fde0b20c53f77174a8e0f9f';

let dataDir: string;
const handles: DatabaseHandle[] = [];

/** One connection per simulated process, all on the same data directory. */
function connect(): DatabaseHandle {
  const handle = openDatabase(join(dataDir, 'directivebench.db'));
  handles.push(handle);
  return handle;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-acquired-'));
  await migrateDatabase(connect(), migrations);
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function createRunner(
  handle: DatabaseHandle,
  options: Partial<LocalRunnerOptions> = {},
): LocalRunner {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    cacheDir: join(dataDir, 'cache'),
    adapters: new Map<string, AgentAdapter>([['mock', new MockAgentAdapter()]]),
    workspaceRoot: join(dataDir, 'workspaces'),
    ...options,
  });
}

/** Records the runner's log events, e.g. which jobs it acquired. */
function recordingLogger() {
  const events: RunnerLogFields[] = [];
  return {
    events,
    logger: {
      info: (_message: string, fields: RunnerLogFields = {}) => events.push(fields),
      error: (_message: string, fields: RunnerLogFields = {}) => events.push(fields),
    },
  };
}

/** The bundled example as v2, with v1 an earlier revision of the same skill without the directive. */
async function abExample(handle: DatabaseHandle): Promise<{
  example: ExampleImportResult;
  v1: string;
}> {
  const loaded = await loadLocalArtifact(
    join(examples, 'artifacts'),
    'validate-external-input/SKILL.md',
  );
  const content =
    '---\nname: validate-external-input\ndescription: Earlier revision.\n---\n\n# Validate external input\n\nWrite readable code.\n';
  const v1 = await importArtifactVersion(handle, {
    repository: {
      provider: 'bundled-examples',
      name: 'Bundled examples',
      location: `${examples}/artifacts`,
    },
    path: loaded.path,
    slug: loaded.slug,
    name: loaded.parsed.name,
    type: loaded.parsed.type,
    description: 'Earlier revision.',
    format: loaded.parsed.format,
    primaryFile: loaded.primaryFile,
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
    parsedMetadata: {},
  });
  const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
  expect(example.artifact.artifactId).toBe(v1.artifactId);
  expect(example.artifact.version).toBe(2);
  return { example, v1: v1.versionId };
}

/** A mock agent whose runs wait until they are aborted, so a test can act while a job runs. */
class BlockingMockAdapter extends MockAgentAdapter {
  private started!: () => void;
  readonly running = new Promise<void>((resolve) => {
    this.started = resolve;
  });

  override run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.started();
    return new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () =>
          resolve({
            status: 'agent-error',
            durationMs: 0,
            summary: 'aborted',
            trace: [],
            usage: null,
            error: null,
          }),
        { once: true },
      );
    });
  }
}

describe('A/B baseline in the runner (SPEC-118 FR-118-11…13)', () => {
  it('runs the baseline version against the candidate and stores it on the run, with the mock key unchanged', async () => {
    const handle = connect();
    const { example, v1 } = await abExample(handle);
    const ab = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
      baselineArtifactVersionId: v1,
    });
    const none = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const results = await createRunner(handle).runUntilIdle();
    // Both jobs may share a `createdAt` millisecond, so their order is not asserted.
    const byJob = new Map(results.map((r) => [r.jobId, r]));
    expect(results).toHaveLength(2);
    expect(byJob.get(ab.id)?.status).toBe('completed');
    expect(byJob.get(none.id)?.status).toBe('completed');

    const abRun = await getBenchmarkRunDetail(
      handle.db,
      byJob.get(ab.id)?.benchmarkRunId as string,
    );
    expect(abRun?.run).toMatchObject({
      status: 'completed',
      verdict: 'improved',
      artifactVersionId: example.artifact.versionId,
      baselineArtifactVersionId: v1,
      comparabilityKey: MOCK_EXAMPLE_KEY,
    });
    // Every baseline agent run installed v1 by the candidate's convention.
    for (const run of abRun?.agentRuns ?? []) {
      expect(run.trace).toContainEqual({
        type: 'message',
        text: 'Installed artifact files: .agents/skills/validate-external-input/SKILL.md',
      });
    }
    const noneRun = await getBenchmarkRunDetail(
      handle.db,
      byJob.get(none.id)?.benchmarkRunId as string,
    );
    expect(noneRun?.run).toMatchObject({
      baselineArtifactVersionId: null,
      comparabilityKey: MOCK_EXAMPLE_KEY,
    });
  }, 60_000);

  it('re-validates the baseline when it loads the job and fails it before any run exists', async () => {
    const handle = connect();
    const { example } = await abExample(handle);
    const other = await importArtifactVersion(handle, {
      repository: { provider: 'local-directory', name: 'other', location: '/tmp/other' },
      path: 'skills/other',
      slug: 'other',
      name: 'other',
      type: 'skill',
      description: null,
      format: 'skill-md',
      primaryFile: 'SKILL.md',
      files: [{ path: 'SKILL.md', sha256: sha256('o'), size: 1, content: 'o' }],
      parsedMetadata: {},
    });
    // Stored behind the job repository's back, as if the rules had changed since enqueueing.
    const insert = handle.sqlite.prepare(
      "insert into jobs (id, type, status, payload, created_at) values (?, 'benchmark-run', 'pending', ?, ?)",
    );
    const payload = (baselineArtifactVersionId: string) =>
      JSON.stringify({
        suiteVersionId: example.suite.versionId,
        artifactVersionId: example.artifact.versionId,
        baselineArtifactVersionId,
      });
    insert.run('job_a_other', payload(other.versionId), '2026-01-01T00:00:00.000Z');
    insert.run('job_b_gone', payload('artv_gone'), '2026-01-01T00:00:01.000Z');

    const results = await createRunner(handle).runUntilIdle();
    expect(results).toEqual([
      {
        jobId: 'job_a_other',
        status: 'failed',
        benchmarkRunId: null,
        error:
          'Invalid baseline: The baseline must be another version of the same artifact as the candidate.',
      },
      {
        jobId: 'job_b_gone',
        status: 'failed',
        benchmarkRunId: null,
        error: 'Baseline artifact version no longer exists',
      },
    ]);
    expect(await handle.db.$count(schema.benchmarkRuns)).toBe(0);
  }, 60_000);
});

describe('jobs created already acquired (SPEC-118 FR-118-34, AC-9)', () => {
  it('a serve runner polling the same data directory never acquires the CLI job', async () => {
    const cliHandle = connect();
    const serveHandle = connect();
    const example = await importBundledExample(cliHandle, examples, join(dataDir, 'fixtures'));
    const payload = {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    };
    const serveLog = recordingLogger();
    const serve = createRunner(serveHandle, {
      pollIntervalMs: 1,
      heartbeatIntervalMs: 20,
      logger: serveLog.logger,
    });
    const cli = createRunner(cliHandle, { heartbeatIntervalMs: 20 });
    await serve.start();
    try {
      const cliJob = await createAcquiredBenchmarkJob(
        cliHandle.db,
        payload,
        cli.runnerId,
        nowIso(),
      );
      const running = cli.runAcquiredJob(cliJob.id);
      // A job the web app enqueued meanwhile is still served, so `serve` is really polling.
      const queued = await enqueueBenchmarkJob(serveHandle.db, payload);
      const result = await running;
      expect(result).toMatchObject({ jobId: cliJob.id, status: 'completed', error: null });
      expect(await getJob(cliHandle.db, cliJob.id)).toMatchObject({
        status: 'completed',
        runnerId: cli.runnerId,
        attempts: 1,
      });
      await expect
        .poll(async () => (await getJob(serveHandle.db, queued.id))?.status, { timeout: 30_000 })
        .toBe('completed');
      expect((await getJob(serveHandle.db, queued.id))?.runnerId).toBe(serve.runnerId);
      const acquiredByServe = serveLog.events
        .filter((e) => e.event === 'acquired')
        .map((e) => e.jobId);
      expect(acquiredByServe).toEqual([queued.id]);
    } finally {
      await serve.stop();
    }
  }, 60_000);

  it('leaves a job whose creator died to the interrupted recovery', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const job = await createAcquiredBenchmarkJob(
      handle.db,
      { suiteVersionId: example.suite.versionId, artifactVersionId: example.artifact.versionId },
      'local-dead-cli',
      '2000-01-01T00:00:00.000Z',
    );
    const serve = createRunner(connect());
    expect(await serve.recover()).toEqual([job.id]);
    expect(await getJob(handle.db, job.id)).toMatchObject({ status: 'interrupted' });
  });

  it('observes cancellation requests and shutdown like a polled job', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const payload = {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    };

    const cancelAdapter = new BlockingMockAdapter();
    const cancelRunner = createRunner(handle, {
      heartbeatIntervalMs: 10,
      adapters: new Map<string, AgentAdapter>([['mock', cancelAdapter]]),
    });
    const cancelled = await createAcquiredBenchmarkJob(
      handle.db,
      payload,
      cancelRunner.runnerId,
      nowIso(),
    );
    const cancelling = cancelRunner.runAcquiredJob(cancelled.id);
    await cancelAdapter.running;
    expect(cancelRunner.activeJobCount).toBe(1);
    await requestJobCancellation(handle.db, cancelled.id);
    expect(await cancelling).toMatchObject({ status: 'cancelled' });
    expect(cancelRunner.activeJobCount).toBe(0);

    const stopAdapter = new BlockingMockAdapter();
    const stopRunner = createRunner(handle, {
      adapters: new Map<string, AgentAdapter>([['mock', stopAdapter]]),
    });
    const interrupted = await createAcquiredBenchmarkJob(
      handle.db,
      payload,
      stopRunner.runnerId,
      nowIso(),
    );
    const stopping = stopRunner.runAcquiredJob(interrupted.id);
    await stopAdapter.running;
    await stopRunner.stop();
    expect(await stopping).toMatchObject({ status: 'interrupted' });
    expect((await getJob(handle.db, interrupted.id))?.status).toBe('interrupted');
  }, 60_000);

  it('refuses jobs it does not own, that are not running or that already run here', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const payload = {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    };
    const adapter = new BlockingMockAdapter();
    const runner = createRunner(handle, {
      adapters: new Map<string, AgentAdapter>([['mock', adapter]]),
    });
    const pending = await enqueueBenchmarkJob(handle.db, payload);
    const foreign = await createAcquiredBenchmarkJob(handle.db, payload, 'local-other', nowIso());
    for (const jobId of [pending.id, foreign.id, 'job_unknown']) {
      await expect(runner.runAcquiredJob(jobId)).rejects.toThrow(
        new JobNotAcquiredError(`Job ${jobId} is not running for runner ${runner.runnerId}`),
      );
    }

    const own = await createAcquiredBenchmarkJob(handle.db, payload, runner.runnerId, nowIso());
    const first = runner.runAcquiredJob(own.id);
    await adapter.running;
    await expect(runner.runAcquiredJob(own.id)).rejects.toThrow(
      `Job ${own.id} is already executing in this runner`,
    );
    await runner.stop();
    expect(await first).toMatchObject({ status: 'interrupted' });
  }, 60_000);
});

describe('systematic agent failures (SPEC-118 FR-118-15, AC-17)', () => {
  it('a rate-limited first agent run ends the benchmark run as error without further runs', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const limited = new (class extends MockAgentAdapter {
      calls = 0;
      override async run(): Promise<AgentRunResult> {
        this.calls += 1;
        return {
          status: 'agent-error',
          durationMs: 1,
          summary: 'rate limited',
          trace: [],
          usage: null,
          error: 'Claude Code failed (rate-limited): API Error: Rate limit reached',
          errorCode: 'rate-limited',
        };
      }
    })();
    const job = await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const [result] = await createRunner(handle, {
      adapters: new Map<string, AgentAdapter>([['mock', limited]]),
    }).runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'failed' });
    expect(limited.calls).toBe(1);
    const detail = await getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'error', verdict: 'error' });
    expect(detail?.run.error).toMatch(/^Stopped after case .+ \(rate-limited\): /);
    expect(detail?.agentRuns).toHaveLength(1);
  }, 60_000);
});

describe('the CLI runner (SPEC-118 FR-118-36, §8.3)', () => {
  it('cancels an active job at once, as the user would', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const adapter = new BlockingMockAdapter();
    // No heartbeat during the test: the cancellation must not wait for one.
    const runner = createRunner(handle, {
      heartbeatIntervalMs: 3_600_000,
      adapters: new Map<string, AgentAdapter>([['mock', adapter]]),
    });
    const job = await createAcquiredBenchmarkJob(
      handle.db,
      { suiteVersionId: example.suite.versionId, artifactVersionId: example.artifact.versionId },
      runner.runnerId,
      nowIso(),
    );
    expect(runner.cancel(job.id)).toBe(false);
    const running = runner.runAcquiredJob(job.id);
    await adapter.running;
    expect(runner.cancel(job.id)).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ status: 'cancelled' });
    const detail = await getBenchmarkRunDetail(handle.db, result.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'cancelled', error: 'Cancelled by user' });
  }, 60_000);

  it('passes the installation id to runs of the user-profile isolation profile', async () => {
    const handle = connect();
    const example = await importBundledExample(handle, examples, join(dataDir, 'fixtures'));
    const profiled = new (class extends MockAgentAdapter {
      override async run(request: AgentRunRequest): Promise<AgentRunResult> {
        const result = await super.run(request);
        return {
          ...result,
          metadata: {
            adapterVersion: '2.1.302',
            authMode: 'subscription',
            isolationProfile: 'user-profile',
            permissionProfile: 'edit-only',
            requestedModel: 'claude-test',
            executionModel: 'claude-test',
            reportedModels: ['claude-test'],
            auxiliaryModels: [],
            mismatchedMessageModels: [],
            flagsHash: 'f'.repeat(64),
          },
        };
      }
    })();
    const runner = createRunner(handle, {
      hostId: '00000000-0000-4000-8000-0000000000aa',
      adapters: new Map<string, AgentAdapter>([['mock', profiled]]),
    });
    const job = await createAcquiredBenchmarkJob(
      handle.db,
      { suiteVersionId: example.suite.versionId, artifactVersionId: example.artifact.versionId },
      runner.runnerId,
      nowIso(),
    );
    const result = await runner.runAcquiredJob(job.id);
    const detail = await getBenchmarkRunDetail(handle.db, result.benchmarkRunId as string);
    const summary = detail?.run.summary as { environment: { agentProfile?: { hostId?: string } } };
    expect(summary.environment.agentProfile?.hostId).toBe('00000000-0000-4000-8000-0000000000aa');
  }, 60_000);
});
