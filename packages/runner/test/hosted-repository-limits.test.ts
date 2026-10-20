import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as core from '@directivebench/core';
import {
  enqueueRepositoryScanJob,
  getRepository,
  migrateDatabase,
  openDatabase,
  type DatabaseHandle,
  type RepositoryRecord,
} from '@directivebench/database';
import type * as hostedGit from '../src/hosted-git';
import { ScanCancelledError, registerHostedUrl, scanHostedRepository } from '../src/index';
import { FixtureRemote, fileTransport } from './support/hosted-fixtures';

// The per-scan byte limit, lowered so a small fixture exceeds it, and a hook into discovery.
const hooks = vi.hoisted(() => ({
  maxScanBytes: undefined as number | undefined,
  beforeDiscovery: null as (() => void) | null,
  tooManyCandidates: false,
  readFails: false,
}));
vi.mock('@directivebench/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return {
    ...actual,
    get DISCOVERY_LIMITS() {
      return {
        ...actual.DISCOVERY_LIMITS,
        maxScanBytes: hooks.maxScanBytes ?? actual.DISCOVERY_LIMITS.maxScanBytes,
      };
    },
    selectCandidateFiles: (...args: Parameters<typeof actual.selectCandidateFiles>) => {
      if (hooks.tooManyCandidates) {
        throw new actual.DiscoveryLimitError('maxCandidatesPerScan', 'Discovery aborted: too many');
      }
      return actual.selectCandidateFiles(...args);
    },
    discoverArtifactsInTree: (...args: Parameters<typeof actual.discoverArtifactsInTree>) => {
      hooks.beforeDiscovery?.();
      return actual.discoverArtifactsInTree(...args);
    },
  };
});

vi.mock('../src/hosted-git', async (importOriginal) => {
  const actual = await importOriginal<typeof hostedGit>();
  return {
    ...actual,
    readBlobs: (...args: Parameters<typeof actual.readBlobs>) =>
      hooks.readFails
        ? Promise.resolve({
            ok: false,
            code: 'git-failed',
            message: 'A file could not be read from the cache.',
          })
        : actual.readBlobs(...args),
  };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));

let handle: DatabaseHandle;
let dataDir: string;
let remotes: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-hosted-limits-'));
  remotes = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-hosted-limits-remotes-')));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  hooks.maxScanBytes = undefined;
  hooks.beforeDiscovery = null;
  hooks.tooManyCandidates = false;
  hooks.readFails = false;
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
});

async function prepare(signal = new AbortController().signal) {
  const remote = new FixtureRemote(remotes, 'acme', 'skills', {
    'AGENTS.md': '# Rules\n',
    'skill/SKILL.md': '---\nname: s\ndescription: d\n---\n',
  });
  const options = {
    env: { PATH: process.env.PATH },
    signal,
    cacheDir: join(dataDir, 'cache'),
    transport: fileTransport(remotes),
  };
  const registered = await registerHostedUrl(handle, remote.location, options);
  if (!registered.ok) throw new Error(registered.message);
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: registered.repositoryId });
  handle.sqlite.prepare(`update jobs set status = 'running' where id = ?`).run(job.id);
  const repository = (await getRepository(handle.db, registered.repositoryId)) as RepositoryRecord;
  return {
    run: () => scanHostedRepository(handle, { jobId: job.id, repository }, options),
    repository,
  };
}

describe('scanHostedRepository limits and late failures', () => {
  it('refuses to load candidate files beyond the per-scan byte limit', async () => {
    const { run, repository } = await prepare();
    hooks.maxScanBytes = 10;
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'Discovery aborted: the candidate files exceed the limit of 10 bytes per scan',
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
  });

  it('aborts before any download when there are too many candidates', async () => {
    const { run } = await prepare();
    hooks.tooManyCandidates = true;
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'Discovery aborted: too many',
    });
  });

  it('fails when the blobs cannot be read from the cache', async () => {
    const { run, repository } = await prepare();
    hooks.readFails = true;
    expect(await run()).toMatchObject({ ok: false, code: 'git-failed' });
    // A failed read deletes the cache.
    expect(existsSync(join(dataDir, 'cache', 'repos', `${repository.id}.git`))).toBe(false);
  });

  it('reports a discovery that fails, and honours a cancellation during discovery', async () => {
    const controller = new AbortController();
    const { run } = await prepare(controller.signal);
    hooks.beforeDiscovery = () => {
      throw new Error('Discovery aborted: limit');
    };
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'Discovery aborted: limit',
    });
    hooks.beforeDiscovery = () => {
      controller.abort('cancelled');
      throw new Error('aborted');
    };
    await expect(run()).rejects.toThrow(ScanCancelledError);
  });

  it('reports a repository removed before the results are stored', async () => {
    const { run, repository } = await prepare();
    hooks.beforeDiscovery = () => {
      handle.sqlite.prepare('delete from repositories where id = ?').run(repository.id);
    };
    expect(await run()).toEqual({
      ok: false,
      code: 'repository-not-found',
      message: 'The repository was removed during the scan.',
    });
  });
});
