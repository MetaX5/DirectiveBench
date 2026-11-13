import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@directivebench/core';
import {
  enqueueRepositoryScanJob,
  getJob,
  migrateDatabase,
  openDatabase,
  removeRepository,
  schema,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  LocalRunner,
  ORPHANED_CACHE_SWEEP_INTERVAL_MS,
  registerHostedUrl,
  sweepOrphanedCaches,
  type LocalRunnerOptions,
  type RunnerLogFields,
} from '../src/index';
import { FixtureRemote, fileTransport } from './support/hosted-fixtures';

// `rm` stays real; a test holds it to observe a sweep in flight.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');

let handle: DatabaseHandle;
let base: string;
let dataDir: string;
let logs: { level: 'info' | 'error'; fields: RunnerLogFields | undefined }[];
const runners: LocalRunner[] = [];
/** Releases every `rm` a test held. */
let releaseRm: () => void;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-runner-sweep-')));
  dataDir = join(base, 'data');
  mkdirSync(dataDir);
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  logs = [];
  releaseRm = () => undefined;
});

afterEach(async () => {
  releaseRm();
  for (const runner of runners.splice(0)) await runner.stop();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  handle.close();
  rmSync(base, { recursive: true, force: true });
});

const cacheDir = () => join(dataDir, 'cache');
const cacheOf = (id: string) => join(cacheDir(), 'repos', `${id}.git`);

function plantCache(id: string): void {
  mkdirSync(join(cacheOf(id), 'objects'), { recursive: true });
  writeFileSync(join(cacheOf(id), 'HEAD'), 'ref: refs/heads/main\n');
}

const logger = {
  info: (_message: string, fields?: RunnerLogFields) => logs.push({ level: 'info', fields }),
  error: (_message: string, fields?: RunnerLogFields) => logs.push({ level: 'error', fields }),
};

function createRunner(overrides: Partial<LocalRunnerOptions> = {}): LocalRunner {
  const runner = new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    cacheDir: cacheDir(),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    pollIntervalMs: 10,
    shutdownTimeoutMs: 5000,
    logger,
    ...overrides,
  });
  runners.push(runner);
  return runner;
}

/** Makes the next `rm` calls wait until `releaseRm()`; resolves the returned promise on the first. */
function holdRm(): Promise<void> {
  const actual = vi.mocked(fsPromises.rm).getMockImplementation() as typeof fsPromises.rm;
  let gate!: () => void;
  const released = new Promise<void>((resolve) => {
    gate = resolve;
  });
  releaseRm = gate;
  let reached!: () => void;
  const first = new Promise<void>((resolve) => {
    reached = resolve;
  });
  vi.mocked(fsPromises.rm).mockImplementation(async (...args) => {
    reached();
    await released;
    return actual(...args);
  });
  return first;
}

const events = () => logs.map(({ fields }) => fields?.event);

/** A job the runner fails at once (an invalid stored payload), standing in for any work. */
async function insertQuickJob(): Promise<string> {
  const id = createId('job');
  await handle.db.insert(schema.jobs).values({
    id,
    type: 'repository-registration',
    status: 'pending',
    payload: {} as never,
    createdAt: new Date().toISOString(),
  });
  return id;
}

describe('the runner sweeps orphaned caches (SPEC-105 FR-105-19, issue 59 J2)', () => {
  it('sweeps once a minute by default', () => {
    expect(ORPHANED_CACHE_SWEEP_INTERVAL_MS).toBe(60_000);
  });

  it('sweeps at start after recovering stale jobs, without delaying the first job', async () => {
    const orphan = createId('repo');
    plantCache(orphan);
    // A scan job left running by a crashed runner names the orphan: recovery ends it first.
    await handle.db.insert(schema.jobs).values({
      id: createId('job'),
      type: 'repository-scan',
      status: 'running',
      payload: { repositoryId: orphan },
      createdAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
    });
    const quick = await insertQuickJob();
    const deleting = holdRm();
    const runner = createRunner();
    await runner.start();
    await deleting;
    // The deletion is held, and the first job still runs.
    await vi.waitFor(async () => expect((await getJob(handle.db, quick))?.status).toBe('failed'));
    expect(existsSync(cacheOf(orphan))).toBe(true);
    releaseRm();
    await vi.waitFor(() => expect(existsSync(cacheOf(orphan))).toBe(false));
    expect(events().filter((event) => event === 'recovered' || event === 'cache-deleted')).toEqual([
      'recovered',
      'cache-deleted',
    ]);
  });

  it('sweeps again on its timer, one sweep at a time, and stop() waits for it', async () => {
    const runner = createRunner({ orphanedCacheSweepIntervalMs: 10 });
    await runner.start();
    const orphan = createId('repo');
    plantCache(orphan);
    const deleting = holdRm();
    await deleting;
    // Several intervals pass while the sweep is held: no second sweep starts.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(vi.mocked(fsPromises.rm)).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    releaseRm();
    await stopping;
    expect(existsSync(cacheOf(orphan))).toBe(false);
    expect(events()).toContain('cache-deleted');

    // Stopped: the timer is cleared, so a new orphan stays.
    vi.mocked(fsPromises.rm).mockClear();
    const later = createId('repo');
    plantCache(later);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(existsSync(cacheOf(later))).toBe(true);
    expect(vi.mocked(fsPromises.rm)).not.toHaveBeenCalled();
  });

  it('starts no sweep when stop() lands during recovery', async () => {
    const orphan = createId('repo');
    plantCache(orphan);
    const runner = createRunner({ orphanedCacheSweepIntervalMs: 10 });
    const starting = runner.start();
    await runner.stop();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(cacheOf(orphan))).toBe(true);
  });

  it('never sweeps in runUntilIdle', async () => {
    const orphan = createId('repo');
    plantCache(orphan);
    await insertQuickJob();
    const runner = createRunner();
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'failed' }]);
    expect(existsSync(cacheOf(orphan))).toBe(true);
  });

  it('keeps running jobs when a sweep fails', async () => {
    mkdirSync(cacheDir());
    writeFileSync(join(cacheDir(), 'repos'), 'a file');
    const quick = await insertQuickJob();
    const runner = createRunner();
    await runner.start();
    await vi.waitFor(async () => expect((await getJob(handle.db, quick))?.status).toBe('failed'));
    expect(logs).toContainEqual({
      level: 'error',
      fields: { event: 'cache-sweep-failed', code: 'ENOTDIR' },
    });
  });
});

describe('a repository removed during its hosted scan (issue 59 J3)', () => {
  posixOnly(
    'keeps the cache until the running scan ends, then the next sweep deletes it',
    async () => {
      const remotes = join(base, 'remotes');
      mkdirSync(remotes);
      const remote = new FixtureRemote(remotes, 'acme', 'held', { 'AGENTS.md': '# Rules\n' });
      // A git on PATH that, while `hold` exists, waits for `gate` before any fetch.
      const bin = join(base, 'bin');
      mkdirSync(bin);
      const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
      const hold = join(base, 'hold');
      const reached = join(base, 'reached');
      const gate = join(base, 'gate');
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh
if [ -e "${hold}" ]; then
  for arg in "$@"; do
    if [ "$arg" = fetch ]; then
      : > "${reached}"
      while [ ! -e "${gate}" ]; do sleep 0.05; done
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      releaseRm = () => writeFileSync(gate, '');

      const transport = fileTransport(remotes);
      const registration = await registerHostedUrl(handle, remote.location, {
        env: process.env,
        signal: new AbortController().signal,
        cacheDir: cacheDir(),
        transport,
      });
      if (!registration.ok) throw new Error(registration.message);
      const id = registration.repositoryId;
      const runner = createRunner({
        hostedGitTransport: transport,
        hostedGitLimits: { cacheSizePollIntervalMs: 5 },
      });
      await enqueueRepositoryScanJob(handle, { repositoryId: id });
      expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
      expect(existsSync(cacheOf(id))).toBe(true);

      // The rescan fetches into the existing cache and is held there.
      writeFileSync(hold, '');
      await enqueueRepositoryScanJob(handle, { repositoryId: id });
      const scanning = runner.runUntilIdle();
      await vi.waitFor(() => expect(existsSync(reached)).toBe(true), { timeout: 10_000 });
      expect(await removeRepository(handle, id)).toMatchObject({ status: 'removed' });

      const sweep = () =>
        sweepOrphanedCaches({ handle, cacheDir: cacheDir(), logger, reportedFailures: new Set() });
      await sweep();
      expect(existsSync(cacheOf(id))).toBe(true);

      writeFileSync(gate, '');
      expect(await scanning).toMatchObject([
        { status: 'failed', error: 'The repository was removed during the scan.' },
      ]);
      expect(existsSync(cacheOf(id))).toBe(true);
      await sweep();
      expect(existsSync(cacheOf(id))).toBe(false);
      expect(logs).toContainEqual({
        level: 'info',
        fields: { event: 'cache-deleted', repositoryId: id },
      });
    },
    30_000,
  );
});
