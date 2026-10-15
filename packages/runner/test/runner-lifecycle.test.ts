import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockAgentAdapter,
  type AgentAdapter,
  type AgentDetection,
  type AgentRunRequest,
  type AgentRunResult,
} from '@directivebench/agent-adapters';
import {
  enqueueBenchmarkJob,
  getBenchmarkRunDetail,
  getJob,
  getSuiteVersion,
  listArtifacts,
  migrateDatabase,
  openDatabase,
  requestJobCancellation,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  LocalRunner,
  importBenchmarkSuite,
  importLocalArtifact,
  type LocalRunnerOptions,
  type RunnerLogFields,
  type RunnerLogger,
} from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const examples = fileURLToPath(new URL('../../../examples', import.meta.url));

/**
 * A minimal suite without commands (so it needs no execution approval), one case and one
 * repetition: each job runs the mock agent twice (baseline + candidate) in milliseconds.
 */
const MINI_SUITE = `schemaVersion: 1
id: mini-suite
name: Mini suite
execution:
  agent: mock
  timeoutSeconds: 30
  repetitions: 1
cases:
  - id: write-note
    name: Write a note
    prompt: Write done into note.txt.
    fixture:
      path: ./fixture
    assertions:
      - id: note-written
        type: file-contains
        path: note.txt
        pattern: done
    agentOptions:
      mock:
        playbook:
          - id: write
            write:
              path: note.txt
              content: done
`;

let handle: DatabaseHandle;
let dataDir: string;
const extraHandles: DatabaseHandle[] = [];
const runners: LocalRunner[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-runner-lifecycle-'));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(async () => {
  vi.useRealTimers();
  // Abort anything a failed assertion left running before the database is closed.
  for (const runner of runners.splice(0)) await runner.stop();
  for (const extra of extraHandles.splice(0)) extra.close();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface MiniFixture {
  payload: { suiteVersionId: string; artifactVersionId: string };
  fixtureStore: string;
}

async function importMini(): Promise<MiniFixture> {
  const suiteDir = join(dataDir, 'source', 'mini-suite');
  mkdirSync(join(suiteDir, 'fixture'), { recursive: true });
  writeFileSync(join(suiteDir, 'fixture', 'README.md'), '# Fixture\n');
  writeFileSync(join(suiteDir, 'benchmark.yaml'), MINI_SUITE);
  const fixtureStore = join(dataDir, 'fixtures');
  const suite = await importBenchmarkSuite(
    handle,
    join(suiteDir, 'benchmark.yaml'),
    fixtureStore,
    null,
  );
  const artifact = await importLocalArtifact(
    handle,
    { provider: 'bundled-examples', name: 'Bundled examples', location: `${examples}/artifacts` },
    'validate-external-input/SKILL.md',
  );
  return {
    payload: { suiteVersionId: suite.versionId, artifactVersionId: artifact.versionId },
    fixtureStore,
  };
}

interface LogEntry {
  level: 'info' | 'error';
  message: string;
  fields: RunnerLogFields | undefined;
}

function recordingLogger(): RunnerLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
  };
}

function createRunner(
  fixtureStore: string,
  overrides: Partial<LocalRunnerOptions> = {},
): LocalRunner {
  const runner = new LocalRunner({
    handle,
    fixtureStore,
    adapters: new Map<string, AgentAdapter>([['mock', new MockAgentAdapter()]]),
    workspaceRoot: join(dataDir, 'workspaces'),
    shutdownTimeoutMs: 1000,
    ...overrides,
  });
  runners.push(runner);
  return runner;
}

/** Job statuses counted by value; jobs enqueued in the same millisecond have no fixed order. */
async function statusCounts(jobIds: readonly string[]) {
  const counts: Record<string, number> = {};
  for (const id of jobIds) {
    const status = (await getJob(handle.db, id))?.status ?? 'missing';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function adapters(adapter: AgentAdapter): Map<string, AgentAdapter> {
  return new Map([[adapter.id, adapter]]);
}

/** Mock agent whose runs block until `release()` is called or the run is aborted. */
class GatedAdapter extends MockAgentAdapter {
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  /** Delay after an abort before the run returns (simulates a slow-to-stop agent). */
  constructor(private readonly lingerAfterAbortMs = 0) {
    super();
  }

  release(): void {
    this.releaseGate();
  }

  override async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const aborted = new Promise<void>((resolve) => {
      if (request.signal.aborted) resolve();
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([this.gate, aborted]);
    if (request.signal.aborted) {
      await delay(this.lingerAfterAbortMs);
      return {
        status: 'cancelled',
        durationMs: 0,
        summary: 'Aborted',
        trace: [],
        usage: null,
        error: 'Aborted',
      };
    }
    return super.run(request);
  }
}

/** Mock agent whose n-th `detect()` call (1-based) is replaced by `onCall`. */
class DetectHookAdapter extends MockAgentAdapter {
  private calls = 0;
  constructor(
    private readonly failingCall: number,
    private readonly onCall: () => Promise<AgentDetection>,
  ) {
    super();
  }

  override async detect(): Promise<AgentDetection> {
    this.calls += 1;
    if (this.calls === this.failingCall) return this.onCall();
    return super.detect();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await delay(5);
  }
}

async function jobStatus(jobId: string) {
  return (await getJob(handle.db, jobId))?.status;
}

describe('imports', () => {
  it('imports an artifact without categories and a suite without description or approval', async () => {
    const { payload } = await importMini();
    const [artifact] = await listArtifacts(handle.db);
    expect(artifact?.categories).toEqual([]);

    const suite = await getSuiteVersion(handle.db, payload.suiteVersionId);
    expect(suite?.suite.name).toBe('Mini suite');
    expect(suite?.suite.description).toBeNull();
    expect(suite?.version.executionApprovedAt).toBeNull();
    expect(suite?.version.sourcePath).toBe('mini-suite/benchmark.yaml');

    // Re-importing identical content reuses the stored version.
    const again = await importBenchmarkSuite(
      handle,
      join(dataDir, 'source', 'mini-suite', 'benchmark.yaml'),
      join(dataDir, 'fixtures'),
      null,
    );
    expect(again).toMatchObject({ versionId: payload.suiteVersionId, createdVersion: false });
  });
});

describe('bounded concurrency', () => {
  it('runs up to `concurrency` jobs at once and leaves the rest pending', async () => {
    const { payload, fixtureStore } = await importMini();
    const jobs = [
      await enqueueBenchmarkJob(handle.db, payload),
      await enqueueBenchmarkJob(handle.db, payload),
      await enqueueBenchmarkJob(handle.db, payload),
    ];
    const adapter = new GatedAdapter();
    const runner = createRunner(fixtureStore, { adapters: adapters(adapter), concurrency: 2 });

    await runner.poll();
    expect(runner.activeJobCount).toBe(2);
    expect(await statusCounts(jobs.map((j) => j.id))).toEqual({ running: 2, pending: 1 });

    adapter.release();
    const results = await runner.runUntilIdle();
    expect(results.map((r) => r.jobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(runner.activeJobCount).toBe(0);
  });

  it('defaults to one job at a time', async () => {
    const { payload, fixtureStore } = await importMini();
    const first = await enqueueBenchmarkJob(handle.db, payload);
    const second = await enqueueBenchmarkJob(handle.db, payload);
    const adapter = new GatedAdapter();
    const runner = createRunner(fixtureStore, { adapters: adapters(adapter) });

    await runner.poll();
    expect(runner.activeJobCount).toBe(1);
    expect(await statusCounts([first.id, second.id])).toEqual({ running: 1, pending: 1 });
    const runningFirst = (await jobStatus(first.id)) === 'running' ? first.id : second.id;

    adapter.release();
    const results = await runner.runUntilIdle();
    // Jobs run one after another: the job that was running finishes first.
    expect(results.map((r) => r.jobId)).toEqual([
      runningFirst,
      runningFirst === first.id ? second.id : first.id,
    ]);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
  });

  it('ignores overlapping poll() calls so the limit cannot be exceeded', async () => {
    const { payload, fixtureStore } = await importMini();
    await enqueueBenchmarkJob(handle.db, payload);
    await enqueueBenchmarkJob(handle.db, payload);
    const adapter = new GatedAdapter();
    const runner = createRunner(fixtureStore, { adapters: adapters(adapter), concurrency: 1 });

    await Promise.all([runner.poll(), runner.poll(), runner.poll()]);
    expect(runner.activeJobCount).toBe(1);

    adapter.release();
    expect(await runner.runUntilIdle()).toHaveLength(2);
  });
});

describe('two runners sharing one database', () => {
  function secondHandle(): DatabaseHandle {
    const extra = openDatabase(join(dataDir, 'directivebench.db'));
    extraHandles.push(extra);
    return extra;
  }

  it('acquires a single pending job exactly once', async () => {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    const adapter = new GatedAdapter();
    const a = createRunner(fixtureStore, { adapters: adapters(adapter), concurrency: 4 });
    const b = createRunner(fixtureStore, {
      handle: secondHandle(),
      adapters: adapters(adapter),
      concurrency: 4,
    });

    await Promise.all([a.poll(), b.poll()]);
    expect(a.activeJobCount + b.activeJobCount).toBe(1);
    const claimed = await getJob(handle.db, job.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.runnerId).toBe(a.activeJobCount === 1 ? a.runnerId : b.runnerId);

    adapter.release();
    const results = [...(await a.runUntilIdle()), ...(await b.runUntilIdle())];
    expect(results).toEqual([expect.objectContaining({ jobId: job.id, status: 'completed' })]);
  });

  it('splits a queue between runners without claiming any job twice', async () => {
    const { payload, fixtureStore } = await importMini();
    const jobs = [];
    for (let i = 0; i < 5; i += 1) jobs.push(await enqueueBenchmarkJob(handle.db, payload));
    const adapter = new GatedAdapter();
    const a = createRunner(fixtureStore, { adapters: adapters(adapter), concurrency: 3 });
    const b = createRunner(fixtureStore, {
      handle: secondHandle(),
      adapters: adapters(adapter),
      concurrency: 3,
    });

    await Promise.all([a.poll(), b.poll()]);
    expect(a.activeJobCount + b.activeJobCount).toBe(5);
    expect(a.activeJobCount).toBeLessThanOrEqual(3);
    expect(b.activeJobCount).toBeLessThanOrEqual(3);
    const claimed = await Promise.all(jobs.map((j) => getJob(handle.db, j.id)));
    expect(claimed.every((j) => j?.status === 'running' && j.attempts === 1)).toBe(true);
    expect(claimed.filter((j) => j?.runnerId === a.runnerId)).toHaveLength(a.activeJobCount);
    expect(claimed.filter((j) => j?.runnerId === b.runnerId)).toHaveLength(b.activeJobCount);

    adapter.release();
    const [fromA, fromB] = await Promise.all([a.runUntilIdle(), b.runUntilIdle()]);
    const ids = [...fromA, ...fromB].map((r) => r.jobId);
    expect(ids.sort()).toEqual(jobs.map((j) => j.id).sort());
    expect([...fromA, ...fromB].every((r) => r.status === 'completed')).toBe(true);
  });
});

describe('polling loop', () => {
  it('start() picks up jobs enqueued later and stop() ends polling', async () => {
    const { payload, fixtureStore } = await importMini();
    const runner = createRunner(fixtureStore, { pollIntervalMs: 10 });
    await runner.start();

    const job = await enqueueBenchmarkJob(handle.db, payload);
    await waitFor(async () => (await jobStatus(job.id)) === 'completed');
    await runner.stop();

    const late = await enqueueBenchmarkJob(handle.db, payload);
    await delay(60);
    expect(await jobStatus(late.id)).toBe('pending');
  });

  it('reschedules polls on the poll interval until stopped', async () => {
    const { fixtureStore } = await importMini();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = createRunner(fixtureStore, { pollIntervalMs: 1000 });

    await runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);

    await runner.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reschedule when stopped while a poll is in flight', async () => {
    const { fixtureStore } = await importMini();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = createRunner(fixtureStore, { pollIntervalMs: 1000 });

    await runner.start(); // the first poll is still awaiting the database
    await runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays stopped when stop() is called while start() is still recovering', async () => {
    const { payload, fixtureStore } = await importMini();
    const runner = createRunner(fixtureStore, { pollIntervalMs: 10 });

    const starting = runner.start(); // stop() lands while recover() awaits the database
    await runner.stop();
    await starting;

    const job = await enqueueBenchmarkJob(handle.db, payload);
    await delay(60);
    expect(await jobStatus(job.id)).toBe('pending');
  });

  it('stops every polling chain even if start() was called twice', async () => {
    const { fixtureStore } = await importMini();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = createRunner(fixtureStore, { pollIntervalMs: 1000 });

    await runner.start();
    await runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);

    await runner.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs and survives a failing poll', async () => {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    const logger = recordingLogger();
    const runner = createRunner(fixtureStore, { logger });

    handle.sqlite.exec('alter table jobs rename to jobs_hidden');
    await runner.poll();
    expect(runner.activeJobCount).toBe(0);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: 'error',
        message: expect.stringMatching(/^Runner poll failed: Failed query: update "jobs"/),
        fields: { event: 'poll-failed' },
      }),
    ]);

    // The guard is released: the next poll works once the database is healthy again.
    handle.sqlite.exec('alter table jobs_hidden rename to jobs');
    const results = await runner.runUntilIdle();
    expect(results).toEqual([expect.objectContaining({ jobId: job.id, status: 'completed' })]);
  });

  it('recover() reports nothing when no job is orphaned', async () => {
    const { fixtureStore } = await importMini();
    const logger = recordingLogger();
    expect(await createRunner(fixtureStore, { logger }).recover()).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it('recover() logs the ids of orphaned jobs', async () => {
    const { payload, fixtureStore } = await importMini();
    const orphan = await enqueueBenchmarkJob(handle.db, payload);
    handle.sqlite
      .prepare("update jobs set status = 'running', heartbeat_at = null where id = ?")
      .run(orphan.id);
    const logger = recordingLogger();
    expect(await createRunner(fixtureStore, { logger }).recover()).toEqual([orphan.id]);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'Marked 1 orphaned job(s) as interrupted',
        fields: { event: 'recovered', jobIds: orphan.id },
      },
    ]);
  });
});

describe('heartbeats and cancellation of running jobs', () => {
  it('refreshes the heartbeat and turns a cancellation request into `cancelled`', async () => {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    // Keeps running for a while after the abort, so later heartbeats see an aborted signal.
    const adapter = new GatedAdapter(60);
    const logger = recordingLogger();
    const runner = createRunner(fixtureStore, {
      adapters: adapters(adapter),
      heartbeatIntervalMs: 10,
      logger,
    });

    await runner.poll();
    const startedAt = (await getJob(handle.db, job.id))?.startedAt as string;
    await waitFor(async () => ((await getJob(handle.db, job.id))?.heartbeatAt ?? '') > startedAt);

    expect(await requestJobCancellation(handle.db, job.id)).toBe('running');
    const [result] = await runner.runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'cancelled', error: null });
    expect(await jobStatus(job.id)).toBe('cancelled');
    const detail = await getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'cancelled', error: 'Cancelled by user' });
    expect(
      logger.entries.filter((e) => e.fields?.event === 'cancel-observed').map((e) => e.fields),
    ).toEqual([{ event: 'cancel-observed', jobId: job.id }]);
  });

  it('logs heartbeat failures without failing the job', async () => {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    const adapter = new GatedAdapter();
    const logger = recordingLogger();
    const runner = createRunner(fixtureStore, {
      adapters: adapters(adapter),
      heartbeatIntervalMs: 10,
      logger,
    });

    await runner.poll();
    handle.sqlite.exec(`
      create trigger fail_heartbeat before update of heartbeat_at on jobs
      when old.status = 'running'
      begin select raise(abort, 'heartbeat storage unavailable'); end;
    `);
    await waitFor(() => logger.entries.some((e) => e.fields?.event === 'heartbeat-failed'));
    adapter.release();

    const [result] = await runner.runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'completed' });
    const failure = logger.entries.find((e) => e.fields?.event === 'heartbeat-failed');
    expect(failure).toMatchObject({
      level: 'error',
      message: expect.stringMatching(
        new RegExp(
          `^Heartbeat failed for ${job.id}: Failed query: update "jobs" set "heartbeat_at"`,
        ),
      ),
      fields: { event: 'heartbeat-failed', jobId: job.id },
    });
  });
});

describe('job failures', () => {
  async function runSingle(overrides: Partial<LocalRunnerOptions> = {}, mutate?: () => void) {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    mutate?.();
    const [result] = await createRunner(fixtureStore, overrides).runUntilIdle();
    const stored = await getJob(handle.db, job.id);
    return { job, result, stored, payload };
  }

  it('fails jobs whose payload is malformed', async () => {
    const { result, stored } = await runSingle({}, () => {
      handle.sqlite.exec(`update jobs set payload = '{"suiteVersionId":""}'`);
    });
    expect(result).toMatchObject({ status: 'failed', benchmarkRunId: null });
    expect(result?.error).toMatch(/artifactVersionId/);
    expect(stored).toMatchObject({ status: 'failed', error: result?.error });
  });

  it('fails jobs whose suite version no longer exists', async () => {
    const { result } = await runSingle({}, () => {
      handle.sqlite.exec(
        `update jobs set payload = json_set(payload, '$.suiteVersionId', 'missing')`,
      );
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'Suite or artifact version no longer exists',
    });
  });

  it('fails jobs whose artifact version no longer exists', async () => {
    const { result } = await runSingle({}, () => {
      handle.sqlite.exec(
        `update jobs set payload = json_set(payload, '$.artifactVersionId', 'missing')`,
      );
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'Suite or artifact version no longer exists',
    });
  });

  it('fails jobs whose stored definition no longer validates', async () => {
    const { result } = await runSingle({}, () => {
      handle.sqlite.exec(
        `update benchmark_suite_versions set definition = json_set(definition, '$.cases', json('[]'))`,
      );
    });
    expect(result?.status).toBe('failed');
    expect(result?.error).toMatch(/^Stored definition is invalid: cases: /);
  });

  it('fails jobs whose agent is not available in this build', async () => {
    const other = new MockAgentAdapter();
    const { result } = await runSingle({ adapters: new Map([['other', other]]) });
    expect(result).toMatchObject({
      status: 'failed',
      benchmarkRunId: null,
      error: 'Agent "mock" cannot execute benchmarks in this build (only: other).',
    });
  });

  it('fails jobs when agent detection throws a non-Error value', async () => {
    const adapter = new DetectHookAdapter(1, () => Promise.reject('detector crashed'));
    const { result } = await runSingle({ adapters: adapters(adapter) });
    expect(result).toMatchObject({
      status: 'failed',
      benchmarkRunId: null,
      error: 'detector crashed',
    });
  });

  it('records an errored benchmark run when the engine fails', async () => {
    const blocker = join(dataDir, 'not-a-directory');
    writeFileSync(blocker, '');
    const { result, stored } = await runSingle({ workspaceRoot: blocker });
    expect(result?.status).toBe('failed');
    expect(result?.error).toMatch(/^Benchmark failed: .*not-a-directory/);
    expect(stored?.error).toBe(result?.error);
    const detail = await getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'error', verdict: 'error' });
    expect(detail?.run.error).toMatch(/not-a-directory/);
  });

  it('records an errored benchmark run when the engine throws a non-Error value', async () => {
    // Call 1 is the runner's own detection, call 2 the engine's.
    const adapter = new DetectHookAdapter(2, () => Promise.reject('engine detection crashed'));
    const { result } = await runSingle({ adapters: adapters(adapter) });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'Benchmark failed: engine detection crashed',
    });
    const detail = await getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'error', error: 'engine detection crashed' });
  });

  it('treats any engine error after a cancellation request as a cancellation', async () => {
    const { payload, fixtureStore } = await importMini();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    // Call 3 is the engine's final detection, after all agent runs completed.
    const adapter = new DetectHookAdapter(3, async () => {
      expect(await requestJobCancellation(handle.db, job.id)).toBe('running');
      await delay(50); // several heartbeats observe the request and abort the job
      throw new Error('detector unavailable');
    });
    const runner = createRunner(fixtureStore, {
      adapters: adapters(adapter),
      heartbeatIntervalMs: 5,
    });

    const [result] = await runner.runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'cancelled', error: null });
    const detail = await getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
    expect(detail?.run).toMatchObject({ status: 'cancelled', error: 'Cancelled by user' });
  });
});
