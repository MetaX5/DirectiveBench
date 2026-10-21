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
  beforeDiscovery: null as ((contents: ReadonlyMap<string, unknown>) => void) | null,
  tooManyCandidates: false,
  readFails: false,
  /** The blob IDs of every `readBlobs` call, in order. */
  reads: [] as string[][],
  /** The time limit of every `readBlobs` call, in order. */
  readTimeouts: [] as number[],
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
      hooks.beforeDiscovery?.(args[1]);
      return actual.discoverArtifactsInTree(...args);
    },
  };
});

vi.mock('../src/hosted-git', async (importOriginal) => {
  const actual = await importOriginal<typeof hostedGit>();
  return {
    ...actual,
    readBlobs: (...args: Parameters<typeof actual.readBlobs>) => {
      hooks.reads.push([...args[2].keys()]);
      hooks.readTimeouts.push(args[3]);
      return hooks.readFails
        ? Promise.resolve({
            ok: false,
            code: 'git-failed',
            message: 'A file could not be read from the cache.',
          })
        : actual.readBlobs(...args);
    },
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
  hooks.reads = [];
  hooks.readTimeouts = [];
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
});

/** A binary skill asset: a NUL byte up front, far larger than the text of the fixture. */
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(4096, 7)]);

async function prepare(
  signal = new AbortController().signal,
  extra: {
    files?: Record<string, string | Buffer>;
    readBatchBytes?: number;
    readTotalBytes?: number;
    readTotalMs?: number;
  } = {},
) {
  const remote = new FixtureRemote(remotes, 'acme', 'skills', {
    'AGENTS.md': '# Rules\n',
    'skill/SKILL.md': '---\nname: s\ndescription: d\n---\n',
    ...extra.files,
  });
  const options = {
    env: { PATH: process.env.PATH },
    signal,
    cacheDir: join(dataDir, 'cache'),
    transport: fileTransport(remotes),
    ...(extra.readBatchBytes === undefined ? {} : { readBatchBytes: extra.readBatchBytes }),
    ...(extra.readTotalBytes === undefined ? {} : { readTotalBytes: extra.readTotalBytes }),
    ...(extra.readTotalMs === undefined ? {} : { timeouts: { readTotal: extra.readTotalMs } }),
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
  it('refuses to keep candidate text beyond the per-scan byte limit, keeping the cache', async () => {
    const { run, repository } = await prepare();
    hooks.maxScanBytes = 10;
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'Discovery aborted: the candidate text files exceed the limit of 10 bytes per scan',
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
    // The content is too large, not the cache broken: the next scan fetches into it.
    expect(existsSync(join(dataDir, 'cache', 'repos', `${repository.id}.git`))).toBe(true);
  });

  it('does not count binary candidates toward the per-scan byte limit (issue #61)', async () => {
    // Text: 8 + 31 bytes, within 64; the 4 KiB binary asset alone is far above it.
    const { run } = await prepare(undefined, { files: { 'skill/assets/logo.png': LOGO } });
    hooks.maxScanBytes = 64;
    let held: number[] = [];
    hooks.beforeDiscovery = (contents) => {
      held = [...contents.values()]
        .filter((content): content is Buffer => Buffer.isBuffer(content))
        .map((text) => text.buffer.byteLength - text.length);
    };
    const result = await run();
    // The text read in the same batch as the binary asset does not keep git's output alive.
    expect(held).toEqual([0, 0]);
    expect(result).toMatchObject({ ok: true, discovered: 2, errorCount: 0, warningCount: 1 });
    const skill = handle.sqlite
      .prepare(`select files from artifact_versions where primary_file = 'SKILL.md'`)
      .get() as { files: string };
    expect(JSON.parse(skill.files).map((file: { path: string }) => file.path)).toEqual([
      'SKILL.md',
    ]);
  });

  it('reads the blobs in batches of the batch size, one blob at least', async () => {
    const { run } = await prepare(undefined, {
      files: { 'skill/assets/logo.png': LOGO, 'skill/notes.md': 'notes\n' },
      readBatchBytes: 40,
      readTotalMs: 30_000,
    });
    expect(await run()).toMatchObject({ ok: true, discovered: 2 });
    // Every batch gets what is left of the one deadline, never a fresh 60 s `read`.
    expect(hooks.readTimeouts).toHaveLength(3);
    for (const timeout of hooks.readTimeouts) expect(timeout).toBeLessThanOrEqual(30_000);
    expect(hooks.readTimeouts[2]).toBeLessThan(30_000);
    // Four blobs: the 4 KiB logo alone (above the batch size), the others up to 40 bytes together.
    expect(hooks.reads.map((oids) => oids.length).sort()).toEqual([1, 1, 2]);
    expect(hooks.reads.flat()).toHaveLength(4);
  });

  it('refuses to read more candidate bytes than the read limit, binary included (review of PR #73)', async () => {
    // Many distinct, compressible binary assets: no text budget counts them, the read limit does.
    const assets = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `skill/assets/blob-${index}.bin`,
        Buffer.concat([Buffer.from([0, index]), Buffer.alloc(4096, 0)]),
      ]),
    );
    const { run, repository } = await prepare(undefined, {
      files: assets,
      readTotalBytes: 20 * 4096,
    });
    expect(await run()).toEqual({
      ok: false,
      code: 'scan-failed',
      message: `Discovery aborted: the candidate files to read exceed the limit of ${20 * 4096} bytes per scan`,
    });
    // Refused from the sizes step 4 reports: step 5 reads nothing.
    expect(hooks.reads).toEqual([]);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      syncStatus: 'error',
      syncError: `Discovery aborted: the candidate files to read exceed the limit of ${20 * 4096} bytes per scan`,
    });
    // The content is too large, not the cache broken.
    expect(existsSync(join(dataDir, 'cache', 'repos', `${repository.id}.git`))).toBe(true);
  });

  it('stops reading when the time limit of all the reads is spent', async () => {
    const { run, repository } = await prepare(undefined, { readTotalMs: 0 });
    expect(await run()).toEqual({
      ok: false,
      code: 'timeout',
      message: 'Reading the candidate files from the cache did not finish within the time limit.',
    });
    expect(hooks.reads).toEqual([]);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
    // Like a read that times out, a spent deadline deletes the cache (SPEC-105 §13).
    expect(existsSync(join(dataDir, 'cache', 'repos', `${repository.id}.git`))).toBe(false);
  });

  it('reads candidates whose total is exactly the read limit', async () => {
    // AGENTS.md (8 bytes) and SKILL.md (31 bytes).
    const { run } = await prepare(undefined, { readTotalBytes: 39 });
    expect(await run()).toMatchObject({ ok: true, discovered: 2 });
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
