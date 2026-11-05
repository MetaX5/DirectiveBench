import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  getJob,
  getRepositoryRegistration,
  listRepositories,
  migrateDatabase,
  openDatabase,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  LocalRunner,
  UNEXPECTED_JOB_FAILURE,
  type RunnerLogFields,
  type RunnerLogger,
} from '../src/index';
import { FixtureRemote, fileTransport } from './support/hosted-fixtures';

// Issue #70: a registration or scan job that throws an error no step turned into an outcome of
// its own ends `failed` with a fixed message naming the job type. The raw error, which can name
// internal details, reaches only the runner log. Errors are injected with SQLite triggers, so
// the database write fails for real, through Drizzle, where the job would make it.

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
/** Stands for internal detail a raw error may carry: an absolute path. */
const INTERNAL_DETAIL = '/home/someone/private/internal-detail';

interface LogEntry {
  level: 'info' | 'error';
  message: string;
  fields: RunnerLogFields | undefined;
}

let handle: DatabaseHandle;
let dataDir: string;
let sources: string;
let entries: LogEntry[];

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-runner-unexpected-')));
  sources = join(dataDir, 'sources');
  mkdirSync(join(sources, 'local'), { recursive: true });
  writeFileSync(join(sources, 'local', 'AGENTS.md'), '# Rules\n');
  entries = [];
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function createRunner(): LocalRunner {
  const logger: RunnerLogger = {
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
  };
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    cacheDir: join(dataDir, 'cache'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    hostedGitTransport: fileTransport(join(dataDir, 'remotes')),
    logger,
  });
}

/** Makes every `operation` on `table` fail with a SQLite error that names internal detail. */
function failWrites(table: string, operation: 'insert' | 'update'): void {
  handle.sqlite.exec(
    `create trigger injected_failure before ${operation} on ${table} ` +
      `begin select raise(abort, 'injected failure at ${INTERNAL_DETAIL}'); end`,
  );
}

/** The job ended with the fixed message; the raw error reached only the runner log. */
async function expectFixedFailure(
  jobId: string,
  type: 'repository-registration' | 'repository-scan',
  result: { status: string; error: string | null } | undefined,
): Promise<void> {
  expect(result).toMatchObject({ status: 'failed', error: UNEXPECTED_JOB_FAILURE[type] });
  const stored = await getJob(handle.db, jobId);
  expect(stored).toMatchObject({ status: 'failed', error: UNEXPECTED_JOB_FAILURE[type] });
  expect(JSON.stringify(stored)).not.toContain(INTERNAL_DETAIL);
  expect(entries.filter((e) => e.fields?.event === 'job-error')).toEqual([
    {
      level: 'error',
      // Drizzle's "Failed query: … params: …" wrapper is dropped; its cause says why.
      message: `Job ${jobId} failed unexpectedly: Error: injected failure at ${INTERNAL_DETAIL}`,
      fields: { event: 'job-error', jobId, jobType: type, benchmarkRunId: null },
    },
  ]);
  const finished = entries.find((e) => e.fields?.event === 'finished');
  expect(finished?.message).not.toContain(INTERNAL_DETAIL);
}

describe('jobs that fail unexpectedly (issue #70)', () => {
  it('names the job type in the fixed message of every job type', () => {
    expect(Object.keys(UNEXPECTED_JOB_FAILURE).sort()).toEqual([
      'benchmark-run',
      'repository-registration',
      'repository-scan',
    ]);
    expect(UNEXPECTED_JOB_FAILURE['benchmark-run']).toMatch(/^The benchmark run failed/);
    expect(UNEXPECTED_JOB_FAILURE['repository-registration']).toMatch(
      /^The repository registration failed/,
    );
    expect(UNEXPECTED_JOB_FAILURE['repository-scan']).toMatch(/^The repository scan failed/);
  });

  it('ends a local registration whose database write fails with the fixed message', async () => {
    failWrites('repositories', 'insert');
    const job = await enqueueRepositoryRegistrationJob(handle.db, {
      path: join(sources, 'local'),
    });
    const [result] = await createRunner().runUntilIdle();
    await expectFixedFailure(job.id, 'repository-registration', result);
    expect((await getRepositoryRegistration(handle.db, job.id))?.result).toBeNull();
    expect(await listRepositories(handle.db)).toEqual([]);
  });

  it('ends a hosted registration whose database write fails with the fixed message', async () => {
    const remote = new FixtureRemote(join(dataDir, 'remotes'), 'acme', 'skills', {
      'AGENTS.md': '# Rules\n',
    });
    failWrites('repositories', 'insert');
    const job = await enqueueRepositoryRegistrationJob(handle.db, { url: remote.location });
    const [result] = await createRunner().runUntilIdle();
    await expectFixedFailure(job.id, 'repository-registration', result);
    expect(await listRepositories(handle.db)).toEqual([]);
  });

  it('ends a local scan whose database write fails with the fixed message', async () => {
    const runner = createRunner();
    await enqueueRepositoryRegistrationJob(handle.db, { path: join(sources, 'local') });
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    const [repository] = await listRepositories(handle.db);
    // Both the scan's own write and the record of its failure update the repository.
    failWrites('repositories', 'update');
    entries.length = 0;
    const { job } = await enqueueRepositoryScanJob(handle, {
      repositoryId: repository?.id as string,
    });
    const [result] = await runner.runUntilIdle();
    await expectFixedFailure(job.id, 'repository-scan', result);
  });

  it('ends a hosted scan whose database write fails with the fixed message', async () => {
    const remote = new FixtureRemote(join(dataDir, 'remotes'), 'acme', 'skills', {
      'AGENTS.md': '# Rules\n',
    });
    const runner = createRunner();
    await enqueueRepositoryRegistrationJob(handle.db, { url: remote.location });
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    const [repository] = await listRepositories(handle.db);
    expect(repository?.provider).toBe('github');
    failWrites('repositories', 'update');
    entries.length = 0;
    const { job } = await enqueueRepositoryScanJob(handle, {
      repositoryId: repository?.id as string,
    });
    const [result] = await runner.runUntilIdle();
    await expectFixedFailure(job.id, 'repository-scan', result);
  });
});
