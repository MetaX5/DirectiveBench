import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDefinitionFile } from '@directivebench/benchmark-engine/load';
import {
  acquireNextJob,
  getJob,
  getRepositoryRegistration,
  importArtifactVersion,
  importSuiteVersion,
  listJobs,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  cancelJobAction,
  enqueueBenchmarkRunAction,
  registerRepositoryAction,
} from '../lib/actions';
import { DatabaseNotInitializedError, requireDatabase } from '../lib/db';
import { createTempDataDir, initialiseDatabase, resetCachedDatabase } from './support/data-dir';

const next = vi.hoisted(() => {
  /** Stand-in for Next.js' redirect error: `redirect()` never returns. */
  class RedirectError extends Error {
    constructor(readonly url: string) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    RedirectError,
    redirect: vi.fn((url: string): never => {
      throw new RedirectError(url);
    }),
    revalidatePath: vi.fn(),
  };
});
vi.mock('next/navigation', () => ({ redirect: next.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: next.revalidatePath }));

const exampleDefinition = fileURLToPath(
  new URL('../../../examples/benchmarks/mock-input-validation/benchmark.yaml', import.meta.url),
);

let dataDir: ReturnType<typeof createTempDataDir>;
let handle: DatabaseHandle;

beforeEach(async () => {
  dataDir = createTempDataDir();
  vi.stubEnv('DIRECTIVEBENCH_DATA_DIR', dataDir.root);
  resetCachedDatabase();
  await initialiseDatabase(dataDir.database);
  handle = requireDatabase();
});

afterEach(() => {
  resetCachedDatabase();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  dataDir.remove();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(next.RedirectError);
  return (error as InstanceType<typeof next.RedirectError>).url;
}

async function importArtifact(): Promise<{ artifactId: string; versionId: string }> {
  return importArtifactVersion(handle, {
    repository: { provider: 'local-directory', name: 'tests', location: dataDir.root },
    path: 'skills/validate-input',
    slug: 'validate-input',
    name: 'Validate input',
    type: 'skill',
    description: null,
    format: 'skill-md',
    primaryFile: 'SKILL.md',
    files: [{ path: 'SKILL.md', sha256: 'abc', size: 5, content: 'hello' }],
    parsedMetadata: {},
  });
}

async function importSuite(
  definition: Record<string, unknown>,
  approval: 'bundled-example' | null,
): Promise<{ suiteId: string; versionId: string }> {
  return importSuiteVersion(handle, {
    slug: 'mock-input-validation',
    name: 'Input validation',
    description: null,
    schemaVersion: 1,
    definition,
    fixtures: {},
    contentHash: `suite-${JSON.stringify(definition).length}-${approval}`,
    sourcePath: null,
    approval,
  });
}

async function exampleDefinitionDocument(): Promise<Record<string, unknown>> {
  return { ...(await loadDefinitionFile(exampleDefinition)) };
}

describe('enqueueBenchmarkRunAction', () => {
  it('enqueues the latest artifact version and redirects to the executions page', async () => {
    const artifact = await importArtifact();
    const suite = await importSuite(await exampleDefinitionDocument(), 'bundled-example');

    const url = await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );

    expect(url).toBe('/executions');
    expect(next.revalidatePath).toHaveBeenCalledWith('/executions');
    const jobs = await listJobs(handle.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job).toMatchObject({
      status: 'pending',
      payload: { suiteVersionId: suite.versionId, artifactVersionId: artifact.versionId },
    });
  });

  it('refuses a suite that runs commands without execution approval', async () => {
    const artifact = await importArtifact();
    const suite = await importSuite(await exampleDefinitionDocument(), null);

    const url = await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );

    expect(url).toBe(
      `/benchmarks/${suite.suiteId}?error=${encodeURIComponent(
        'This suite version runs commands but has not been approved for execution.',
      )}`,
    );
    expect(await listJobs(handle.db)).toEqual([]);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports every blocker, including an environment this build cannot run', async () => {
    const artifact = await importArtifact();
    const definition = await exampleDefinitionDocument();
    const execution = definition.execution as Record<string, unknown>;
    const suite = await importSuite(
      {
        ...definition,
        execution: { ...execution, environment: { kind: 'docker', image: 'node' } },
      },
      null,
    );

    const url = await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );

    const error = new URL(url, 'http://localhost').searchParams.get('error');
    expect(error).toBe(
      'Execution environment "docker" is not implemented yet; only "local-process" is available. ' +
        'This suite version runs commands but has not been approved for execution.',
    );
    expect(await listJobs(handle.db)).toEqual([]);
  });

  it('refuses a stored definition that no longer validates', async () => {
    const artifact = await importArtifact();
    const suite = await importSuite({ schemaVersion: 1, id: 'broken' }, 'bundled-example');

    const url = await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );

    expect(url).toBe(
      `/benchmarks/${suite.suiteId}?error=${encodeURIComponent('The stored benchmark definition is invalid.')}`,
    );
    expect(await listJobs(handle.db)).toEqual([]);
  });

  it('rejects an unknown suite version', async () => {
    const artifact = await importArtifact();
    await expect(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: 'suitev_missing', artifactId: artifact.artifactId }),
      ),
    ).rejects.toThrow('Suite version not found');
    expect(next.redirect).not.toHaveBeenCalled();
  });

  it('rejects an artifact without versions', async () => {
    const suite = await importSuite(await exampleDefinitionDocument(), 'bundled-example');
    await expect(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: 'art_missing' }),
      ),
    ).rejects.toThrow('Artifact has no versions');
    expect(await listJobs(handle.db)).toEqual([]);
    expect(next.redirect).not.toHaveBeenCalled();
  });

  it('validates the submitted form', async () => {
    await expect(enqueueBenchmarkRunAction(form({ suiteVersionId: 'x' }))).rejects.toThrow(
      /artifactId/,
    );
    await expect(
      enqueueBenchmarkRunAction(form({ suiteVersionId: '', artifactId: 'a' })),
    ).rejects.toThrow(/suiteVersionId/);
  });

  it('fails clearly when the database is not initialised', async () => {
    resetCachedDatabase();
    dataDir.remove();
    await expect(
      enqueueBenchmarkRunAction(form({ suiteVersionId: 's', artifactId: 'a' })),
    ).rejects.toBeInstanceOf(DatabaseNotInitializedError);
  });
});

describe('cancelJobAction', () => {
  async function enqueueJob(): Promise<string> {
    const artifact = await importArtifact();
    const suite = await importSuite(await exampleDefinitionDocument(), 'bundled-example');
    await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );
    const [item] = await listJobs(handle.db);
    vi.clearAllMocks();
    return item?.job.id as string;
  }

  it('cancels a pending job immediately and refreshes the executions page', async () => {
    const jobId = await enqueueJob();

    await cancelJobAction(form({ jobId }));

    const job = await getJob(handle.db, jobId);
    expect(job?.status).toBe('cancelled');
    expect(job?.cancelRequestedAt).not.toBeNull();
    expect(next.revalidatePath).toHaveBeenCalledWith('/executions');
  });

  it('only requests cancellation of a running job; the runner finishes it', async () => {
    const jobId = await enqueueJob();
    await acquireNextJob(handle.db, 'runner-test');

    await cancelJobAction(form({ jobId }));

    const job = await getJob(handle.db, jobId);
    expect(job?.status).toBe('running');
    expect(job?.cancelRequestedAt).not.toBeNull();
  });

  it('requires a job id', async () => {
    await expect(cancelJobAction(form({}))).rejects.toThrow();
    await expect(cancelJobAction(form({ jobId: '' }))).rejects.toThrow();
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('registerRepositoryAction', () => {
  function jobCount(): number {
    return Number(
      (handle.sqlite.prepare('select count(*) as n from jobs').get() as { n: number }).n,
    );
  }

  it('enqueues a registration job and shows its status on the Repositories page', async () => {
    const url = await redirectOf(registerRepositoryAction(form({ path: ' ~/code/skills/ ' })));

    const jobId = new URL(url, 'http://localhost').searchParams.get('registration') as string;
    expect(url).toBe(`/repositories?registration=${jobId}`);
    expect(next.revalidatePath).toHaveBeenCalledWith('/repositories');
    expect(await getRepositoryRegistration(handle.db, jobId)).toMatchObject({
      status: 'pending',
      path: '~/code/skills/',
      result: null,
    });
  });

  it('returns to the form with the entered path and a field error for invalid input', async () => {
    const url = await redirectOf(registerRepositoryAction(form({ path: 'code/skills' })));

    const params = new URL(url, 'http://localhost').searchParams;
    expect(url.startsWith('/repositories?')).toBe(true);
    expect([...params.keys()]).toEqual(['path']);
    expect(params.get('path')).toBe('code/skills');
    expect(jobCount()).toBe(0);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects a missing field or a file upload without echoing it', async () => {
    for (const data of [
      form({}),
      (() => {
        const upload = new FormData();
        upload.set('path', new File(['x'], 'path.txt'));
        return upload;
      })(),
    ]) {
      const params = new URL(await redirectOf(registerRepositoryAction(data)), 'http://localhost')
        .searchParams;
      expect(params.get('path')).toBe('');
    }
    expect(jobCount()).toBe(0);
  });

  it('fails clearly when the database is not initialised', async () => {
    resetCachedDatabase();
    dataDir.remove();
    await expect(registerRepositoryAction(form({ path: '/srv/skills' }))).rejects.toBeInstanceOf(
      DatabaseNotInitializedError,
    );
  });
});
