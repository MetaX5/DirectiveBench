import type * as fsPromises from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as core from '@directivebench/core';
import type * as database from '@directivebench/database';
import { ScanCancelledError, scanLocalRepository } from '../src/repository-scan';

const mocks = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  discoverArtifacts: vi.fn(),
  applyRepositoryScan: vi.fn(),
  getRepository: vi.fn(),
  markRepositoryScanFailed: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  realpath: mocks.realpath,
  stat: mocks.stat,
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
const { ArtifactStoreError, JobNoLongerRunningError, NotFoundError } = await vi.importActual<
  typeof database
>('@directivebench/database');

// The working directory exists, so the stat/access checks after `realpath` pass for real.
const actualFs = await vi.importActual<typeof fsPromises>('node:fs/promises');
const location = actualFs.realpath(process.cwd());
const handle = { db: {} } as unknown as database.DatabaseHandle;
const job = { jobId: 'job_1', repositoryId: 'repo_1' };
const missing = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

function run(signal = new AbortController().signal) {
  return scanLocalRepository(handle, job, { signal, homeDir: '/nonexistent-home', env: {} });
}

beforeEach(async () => {
  vi.resetAllMocks();
  const canonical = await location;
  mocks.getRepository.mockResolvedValue({
    id: 'repo_1',
    provider: 'local-directory',
    location: canonical,
  });
  // Only the location resolves; the user-level folders below the fake home do not exist.
  mocks.realpath.mockImplementation((path: string) =>
    path === canonical ? Promise.resolve(canonical) : Promise.reject(missing()),
  );
  mocks.stat.mockImplementation(actualFs.stat);
  mocks.discoverArtifacts.mockResolvedValue({
    artifacts: [],
    errors: [],
    scannedFiles: 0,
    skippedDirectories: [],
  });
  mocks.applyRepositoryScan.mockResolvedValue({ createdArtifacts: 0, createdVersions: 0 });
});

describe('scanLocalRepository with unexpected errors', () => {
  it('fails the scan and marks the repository for file-system errors it cannot classify', async () => {
    const canonical = await location;
    const io = Object.assign(new Error(`EIO: i/o error, realpath '${canonical}'`), { code: 'EIO' });
    mocks.realpath.mockRejectedValueOnce(io);
    const checkFailed = {
      ok: false,
      code: 'scan-failed',
      message: 'The scan failed: the registered directory could not be checked (EIO).',
    };
    expect(await run()).toEqual(checkFailed);
    expect(mocks.markRepositoryScanFailed).toHaveBeenLastCalledWith(
      handle.db,
      'repo_1',
      checkFailed.message,
    );
    mocks.realpath.mockRejectedValueOnce(new Error(`no code ${canonical}`));
    expect(await run()).toMatchObject({
      code: 'scan-failed',
      message: 'The scan failed: the registered directory could not be checked (unknown error).',
    });
    // `stat` failing after `realpath` (removed in between, or an I/O error) is classified too.
    mocks.stat.mockRejectedValueOnce(missing());
    expect(await run()).toMatchObject({ ok: false, code: 'path-not-found' });
    mocks.stat.mockRejectedValueOnce(io);
    expect(await run()).toEqual(checkFailed);
    expect(mocks.discoverArtifacts).not.toHaveBeenCalled();
    expect(mocks.markRepositoryScanFailed).toHaveBeenCalledTimes(4);
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
    // Neither the error code's message nor any other message names the absolute location.
    const canonical = await location;
    mocks.discoverArtifacts.mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, scandir '${canonical}'`), {
        code: 'EACCES',
      }),
    );
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The scan failed: the directory could not be read (EACCES).',
    });
    mocks.discoverArtifacts.mockRejectedValueOnce(
      new Error(`Discovery root is not a directory: ${canonical}`),
    );
    expect(await run()).toMatchObject({
      message: 'The scan failed: Discovery root is not a directory: <repository>',
    });
    expect(mocks.markRepositoryScanFailed).toHaveBeenCalledTimes(4);
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
      return Promise.resolve({
        artifacts: [],
        errors: [],
        scannedFiles: 0,
        skippedDirectories: [],
      });
    });
    await expect(run(late.signal)).rejects.toThrow('Scan was cancelled');
    expect(mocks.applyRepositoryScan).not.toHaveBeenCalled();
  });

  it('treats a job that stopped running during the apply as cancelled', async () => {
    mocks.applyRepositoryScan.mockRejectedValueOnce(new JobNoLongerRunningError('gone'));
    await expect(run()).rejects.toThrow(ScanCancelledError);
  });

  it('reports a repository removed during the scan and fails on other apply errors', async () => {
    mocks.applyRepositoryScan.mockRejectedValueOnce(new NotFoundError('gone'));
    expect(await run()).toEqual({
      ok: false,
      code: 'repository-not-found',
      message: 'The repository was removed during the scan.',
    });
    expect(mocks.markRepositoryScanFailed).not.toHaveBeenCalled();
    // Drizzle wraps the SQLite error; its message would carry the query parameters (contents).
    const sqlite = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    mocks.applyRepositoryScan.mockRejectedValueOnce(
      new Error('Failed query: insert … params: secret file content', { cause: sqlite }),
    );
    const stored = {
      ok: false,
      code: 'scan-failed',
      message: 'The scan failed: the results could not be stored (ERR_SQLITE_ERROR).',
    };
    expect(await run()).toEqual(stored);
    expect(mocks.markRepositoryScanFailed).toHaveBeenLastCalledWith(
      handle.db,
      'repo_1',
      stored.message,
    );
    mocks.applyRepositoryScan.mockRejectedValueOnce(
      Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }),
    );
    expect(await run()).toMatchObject({
      message: 'The scan failed: the results could not be stored (SQLITE_IOERR).',
    });
    mocks.applyRepositoryScan.mockRejectedValueOnce(null);
    expect(await run()).toMatchObject({
      message: 'The scan failed: the results could not be stored (unknown error).',
    });
  });

  it('names where storing the results failed, for a connection or an artifact cause, without contents', async () => {
    const sqlite = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    mocks.applyRepositoryScan.mockRejectedValueOnce(
      new ArtifactStoreError('.agents/skills/review', {
        cause: new Error('Failed query: insert … params: secret file content', { cause: sqlite }),
      }),
    );
    const stored = {
      ok: false,
      code: 'scan-failed',
      message:
        'The scan failed while storing the results at .agents/skills/review (ERR_SQLITE_ERROR).',
    };
    expect(await run()).toEqual(stored);
    expect(mocks.markRepositoryScanFailed).toHaveBeenLastCalledWith(
      handle.db,
      'repo_1',
      stored.message,
    );
    // A connection-level failure (above: a locked database) does not blame the artifact; neither
    // does an artifact-level one. A serialisation error has no code; the path is redacted.
    mocks.applyRepositoryScan.mockRejectedValueOnce(
      new ArtifactStoreError('skills/ghp_abcdefghijklmnopqrstuvwxyz0123456789', {
        cause: new TypeError('Converting circular structure to JSON'),
      }),
    );
    expect(await run()).toMatchObject({
      message: 'The scan failed while storing the results at skills/[REDACTED] (unknown error).',
    });
  });

  it('lists at most MAX_REPORTED_SCAN_ERRORS errors but counts them all', async () => {
    const errors = Array.from({ length: 150 }, (_, index) => ({
      path: `rules/${String(index).padStart(3, '0')}/AGENTS.md`,
      code: 'binary-primary',
      message: 'not text',
    }));
    mocks.discoverArtifacts.mockResolvedValueOnce({
      artifacts: [],
      errors,
      scannedFiles: 150,
      skippedDirectories: [],
    });
    const result = await run();
    expect(result).toMatchObject({ ok: true, errorCount: 150 });
    expect(result.ok && result.errors).toEqual(errors.slice(0, 100));
  });
});
