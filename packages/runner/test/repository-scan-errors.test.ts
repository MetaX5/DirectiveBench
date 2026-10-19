import type * as fsPromises from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as core from '@directivebench/core';
import type * as database from '@directivebench/database';
import { ScanCancelledError, scanLocalRepository } from '../src/repository-scan';

const mocks = vi.hoisted(() => ({
  realpath: vi.fn(),
  discoverArtifacts: vi.fn(),
  applyRepositoryScan: vi.fn(),
  getRepository: vi.fn(),
  markRepositoryScanFailed: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  realpath: mocks.realpath,
}));
vi.mock('@directivebench/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  discoverArtifacts: mocks.discoverArtifacts,
}));
vi.mock('@directivebench/database', async (importOriginal) => ({
  ...(await importOriginal<typeof database>()),
  applyRepositoryScan: mocks.applyRepositoryScan,
  getRepository: mocks.getRepository,
  markRepositoryScanFailed: mocks.markRepositoryScanFailed,
}));

const { DiscoveryRootChangedError } = await vi.importActual<typeof core>('@directivebench/core');
const { JobNoLongerRunningError, NotFoundError } = await vi.importActual<typeof database>(
  '@directivebench/database',
);

// The tmp directory exists, so the stat/access checks after `realpath` pass for real.
const location = (await vi.importActual<typeof fsPromises>('node:fs/promises')).realpath(
  process.cwd(),
);
const handle = { db: {} } as unknown as database.DatabaseHandle;
const job = { jobId: 'job_1', repositoryId: 'repo_1' };

function run(signal = new AbortController().signal) {
  return scanLocalRepository(handle, job, { signal });
}

beforeEach(async () => {
  vi.resetAllMocks();
  const canonical = await location;
  mocks.getRepository.mockResolvedValue({
    id: 'repo_1',
    provider: 'local-directory',
    location: canonical,
  });
  mocks.realpath.mockResolvedValue(canonical);
  mocks.discoverArtifacts.mockResolvedValue({ artifacts: [], errors: [], scannedFiles: 0 });
  mocks.applyRepositoryScan.mockResolvedValue({ createdArtifacts: 0, createdVersions: 0 });
});

describe('scanLocalRepository with unexpected errors', () => {
  it('rethrows file-system errors it cannot classify instead of scanning an unchecked path', async () => {
    const io = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    mocks.realpath.mockRejectedValueOnce(io);
    await expect(run()).rejects.toBe(io);
    const bare = new Error('no code');
    mocks.realpath.mockRejectedValueOnce(bare);
    await expect(run()).rejects.toBe(bare);
    expect(mocks.discoverArtifacts).not.toHaveBeenCalled();
  });

  it('maps a root that changed between the check and the walk to location-changed', async () => {
    mocks.discoverArtifacts.mockRejectedValueOnce(new DiscoveryRootChangedError('moved'));
    expect(await run()).toMatchObject({ ok: false, code: 'location-changed' });
    expect(mocks.markRepositoryScanFailed).toHaveBeenCalledWith(
      handle.db,
      'repo_1',
      expect.stringMatching(/^The registered location now resolves to another place/),
    );
  });

  it('reports other discovery failures as scan-failed with a redacted message', async () => {
    mocks.discoverArtifacts.mockRejectedValueOnce(
      new Error('Discovery aborted: 10001 candidate artifacts exceed the limit'),
    );
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The scan failed: Discovery aborted: 10001 candidate artifacts exceed the limit',
    });
    mocks.discoverArtifacts.mockRejectedValueOnce('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The scan failed: [REDACTED]',
    });
  });

  it('turns an abort during the walk or before the apply into a cancellation that writes nothing', async () => {
    const controller = new AbortController();
    mocks.discoverArtifacts.mockImplementationOnce(() => {
      controller.abort('cancelled');
      return Promise.reject(new Error('cancelled'));
    });
    await expect(run(controller.signal)).rejects.toThrow(ScanCancelledError);

    const late = new AbortController();
    mocks.discoverArtifacts.mockImplementationOnce(() => {
      late.abort('shutdown');
      return Promise.resolve({ artifacts: [], errors: [], scannedFiles: 0 });
    });
    await expect(run(late.signal)).rejects.toThrow('Scan was cancelled');
    expect(mocks.applyRepositoryScan).not.toHaveBeenCalled();
  });

  it('treats a job that stopped running during the apply as cancelled', async () => {
    mocks.applyRepositoryScan.mockRejectedValueOnce(new JobNoLongerRunningError('gone'));
    await expect(run()).rejects.toThrow(ScanCancelledError);
  });

  it('reports a repository removed during the scan and rethrows other apply errors', async () => {
    mocks.applyRepositoryScan.mockRejectedValueOnce(new NotFoundError('gone'));
    expect(await run()).toEqual({
      ok: false,
      code: 'repository-not-found',
      message: 'The repository was removed during the scan.',
    });
    const locked = new Error('database is locked');
    mocks.applyRepositoryScan.mockRejectedValueOnce(locked);
    await expect(run()).rejects.toBe(locked);
  });

  it('lists at most MAX_REPORTED_SCAN_ERRORS errors but counts them all', async () => {
    const errors = Array.from({ length: 150 }, (_, index) => ({
      path: `rules/${String(index).padStart(3, '0')}/AGENTS.md`,
      code: 'binary-primary',
      message: 'not text',
    }));
    mocks.discoverArtifacts.mockResolvedValueOnce({ artifacts: [], errors, scannedFiles: 150 });
    const result = await run();
    expect(result).toMatchObject({ ok: true, errorCount: 150 });
    expect(result.ok && result.errors).toEqual(errors.slice(0, 100));
  });
});
