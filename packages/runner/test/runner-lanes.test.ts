import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  getJob,
  migrateDatabase,
  openDatabase,
  registerLocalRepository,
  requestJobCancellation,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner, SHORT_JOB_SLOTS } from '../src/index';
import type * as registrationModule from '../src/repository-registration';
import type * as scanModule from '../src/repository-scan';
import { ScanCancelledError } from '../src/repository-scan';

/** Scans and registrations that finish only when the test releases them. */
const held = vi.hoisted(() => ({
  scans: [] as { signal: AbortSignal; release: () => void }[],
  registrations: [] as { release: () => void }[],
}));

vi.mock('../src/repository-scan', async (importOriginal) => ({
  ...(await importOriginal<typeof scanModule>()),
  scanLocalRepository: vi.fn(
    (_handle: unknown, _job: unknown, options: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new ScanCancelledError('Scan was cancelled')),
        );
        held.scans.push({
          signal: options.signal,
          release: () =>
            resolve({
              ok: true,
              scannedFiles: 0,
              discovered: 0,
              createdArtifacts: 0,
              createdVersions: 0,
              warningCount: 0,
              errorCount: 0,
              errors: [],
              durationMs: 0,
            }),
        });
      }),
  ),
}));
vi.mock('../src/repository-registration', async (importOriginal) => ({
  ...(await importOriginal<typeof registrationModule>()),
  registerLocalPath: vi.fn(
    () =>
      new Promise((resolve) => {
        held.registrations.push({
          release: () => resolve({ ok: true, repositoryId: 'repo_x', created: true }),
        });
      }),
  ),
}));

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));

let handle: DatabaseHandle;
let dataDir: string;

beforeEach(async () => {
  held.scans.length = 0;
  held.registrations.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-lanes-'));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function createRunner(overrides: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    concurrency: 1,
    ...overrides,
  });
}

async function scanJob(location: string): Promise<string> {
  const outcome = await registerLocalRepository(
    handle,
    { provider: 'local-directory', name: location, location, defaultBranch: null },
    { homeDirectory: '/home/tester', confirmedLocation: null },
  );
  if (outcome.status !== 'registered') throw new Error('not registered');
  return (await enqueueRepositoryScanJob(handle, { repositoryId: outcome.repository.id })).job.id;
}

async function status(jobId: string) {
  return (await getJob(handle.db, jobId))?.status;
}

describe('runner lanes (SPEC-104 OQ-104-06)', () => {
  it('runs a registration while a scan holds the only long slot', async () => {
    expect(SHORT_JOB_SLOTS).toBe(1);
    const scan = await scanJob('/srv/a');
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/b' });
    const runner = createRunner();
    await runner.poll();
    expect(runner.activeJobCount).toBe(2);
    expect(await status(scan)).toBe('running');
    expect(await status(registration.id)).toBe('running');

    held.registrations[0]?.release();
    await vi.waitFor(async () => expect(await status(registration.id)).toBe('completed'));
    expect(await status(scan)).toBe('running');

    held.scans[0]?.release();
    const results = await runner.runUntilIdle();
    expect(results.map((r) => r.jobId)).toEqual([scan]);
    expect(await status(scan)).toBe('completed');
  });

  it('runs long jobs strictly one at a time at concurrency 1, and registrations one at a time', async () => {
    // Distinct creation times: within one millisecond the FIFO order falls back to random ids.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const first = await scanJob('/srv/a');
    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));
    const second = await scanJob('/srv/b');
    vi.setSystemTime(new Date('2026-04-01T00:00:02.000Z'));
    const r1 = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/c' });
    vi.setSystemTime(new Date('2026-04-01T00:00:03.000Z'));
    const r2 = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/d' });
    vi.useRealTimers();
    const runner = createRunner();
    await runner.poll();
    // One long slot and one short slot: a free long slot never takes a registration.
    expect([await status(first), await status(second)]).toEqual(['running', 'pending']);
    expect([await status(r1.id), await status(r2.id)]).toEqual(['running', 'pending']);

    held.scans[0]?.release();
    held.registrations[0]?.release();
    await vi.waitFor(async () => expect(await status(first)).toBe('completed'));
    await runner.poll();
    expect(await status(second)).toBe('running');
    expect(await status(r2.id)).toBe('running');
    held.scans[1]?.release();
    held.registrations[1]?.release();
    await runner.runUntilIdle();
    expect(await status(second)).toBe('completed');
  });

  it('aborts both lanes on shutdown and records a user-cancelled scan as cancelled', async () => {
    const scan = await scanJob('/srv/a');
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/b' });
    const runner = createRunner({ shutdownTimeoutMs: 50 });
    await runner.poll();
    await runner.stop();
    expect(held.scans[0]?.signal.aborted).toBe(true);
    expect(await status(scan)).toBe('interrupted');
    // The held registration ignores the abort, so the shutdown timeout interrupts it.
    expect(await status(registration.id)).toBe('interrupted');

    const cancelled = await scanJob('/srv/c');
    const second = createRunner({ heartbeatIntervalMs: 10 });
    await second.poll();
    expect(await requestJobCancellation(handle.db, cancelled)).toBe('running');
    const [result] = await second.runUntilIdle();
    expect(result).toMatchObject({ jobId: cancelled, status: 'cancelled', error: null });
  });
});
