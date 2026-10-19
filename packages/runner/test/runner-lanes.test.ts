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
  withTransaction,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner, SHORT_JOB_SLOTS, SHUTDOWN_INTERRUPT_GRACE_MS } from '../src/index';
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
        const cancel = () => reject(new ScanCancelledError('Scan was cancelled'));
        if (options.signal.aborted) cancel();
        options.signal.addEventListener('abort', cancel);
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

  // Regression (review of PR #44): stop() only aborted the jobs already active, so a job a poll
  // was claiming at that moment started afterwards and ran unsupervised.
  it('stop() waits for a job that a poll is claiming and interrupts it too', async () => {
    const scan = await scanJob('/srv/a');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An open transaction makes the claim statement wait, so the poll is in flight.
    const holding = withTransaction(handle, async () => gate);
    await new Promise((resolve) => setImmediate(resolve));
    const runner = createRunner({ shutdownTimeoutMs: 1000 });
    const polling = runner.poll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.activeJobCount).toBe(0);
    const stopped = runner.stop();
    release();
    await holding;
    await stopped;
    await polling;
    expect(held.scans[0]?.signal.aborted).toBe(true);
    expect(await status(scan)).toBe('interrupted');
    expect(runner.activeJobCount).toBe(0);
  });

  it('keeps stop() within its timeout when the claim waits, and interrupts the late job', async () => {
    const scan = await scanJob('/srv/a');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withTransaction(handle, async () => gate);
    await new Promise((resolve) => setImmediate(resolve));
    const runner = createRunner({ shutdownTimeoutMs: 20 });
    const polling = runner.poll();
    await new Promise((resolve) => setImmediate(resolve));
    // The claim is still waiting for the transaction when the deadline passes.
    await runner.stop();
    // Read on the raw connection: a Drizzle read would wait for the open transaction.
    expect(handle.sqlite.prepare('select status from jobs where id = ?').get(scan)).toEqual({
      status: 'pending',
    });
    release();
    await holding;
    await polling;
    // Claimed after the deadline: aborted at once, so it never runs unsupervised.
    expect(held.scans[0]?.signal.aborted).toBe(true);
    const [late] = await runner.runUntilIdle();
    expect(late).toMatchObject({ jobId: scan, status: 'interrupted' });
    expect(await status(scan)).toBe('interrupted');
  });

  // Regression (third Codex review of PR #44): past the deadline, stop() awaited the interrupt
  // write without a budget; behind a transaction a job still held it never returned, and the CLI
  // waits for stop() before it terminates the web server.
  it('returns within its deadline plus the grace when the interrupt write waits behind a transaction', async () => {
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/a' });
    const logger = { info: vi.fn(), error: vi.fn() };
    const runner = createRunner({ shutdownTimeoutMs: 20, logger });
    await runner.poll();
    expect(runner.activeJobCount).toBe(1);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The held registration ignores the abort; the open transaction stands for one it holds.
    const holding = withTransaction(handle, async () => gate);
    await new Promise((resolve) => setImmediate(resolve));

    const started = performance.now();
    const budget = 20 + SHUTDOWN_INTERRUPT_GRACE_MS;
    let hang: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      runner.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        hang = setTimeout(() => resolve('still waiting'), budget + 1000);
      }),
    ]);
    clearTimeout(hang);
    const elapsed = performance.now() - started;
    release();
    await holding;
    expect(outcome).toBe('stopped');
    expect(elapsed).toBeGreaterThanOrEqual(budget - 50);
    expect(logger.error).toHaveBeenCalledWith(
      'Shutdown timed out; 1 job(s) stay running until a later runner start recovers them as interrupted',
      { event: 'shutdown-interrupt-skipped', jobIds: registration.id },
    );
    // The skipped write was not dropped: it runs once the transaction ends.
    await vi.waitFor(async () => expect(await status(registration.id)).toBe('interrupted'));
    held.registrations[0]?.release();
  });

  it('logs an interrupt write that fails at shutdown instead of rejecting', async () => {
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/a' });
    const logger = { info: vi.fn(), error: vi.fn() };
    const runner = createRunner({ shutdownTimeoutMs: 20, logger });
    await runner.poll();
    // The write fails at once: its table is gone (restored below so the job can finish).
    handle.sqlite.exec('alter table jobs rename to jobs_hidden');
    await runner.stop();
    handle.sqlite.exec('alter table jobs_hidden rename to jobs');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Shutdown could not mark jobs as interrupted: /),
      { event: 'shutdown-interrupt-failed', jobIds: registration.id },
    );
    const events = logger.error.mock.calls.map(([, fields]) => (fields as { event: string }).event);
    expect(events).not.toContain('shutdown-interrupt-skipped');
    expect(events).not.toContain('shutdown-timeout');
    held.registrations[0]?.release();
    await vi.waitFor(async () => expect(await status(registration.id)).toBe('completed'));
  });
});
