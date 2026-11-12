import { fileURLToPath } from 'node:url';
import { MAX_REPOSITORY_PATH_LENGTH, idListFingerprint } from '@directivebench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDefinitionFile } from '@directivebench/benchmark-engine/load';
import {
  acquireNextJob,
  assignArtifactCategory,
  createBenchmarkRun,
  getArtifactDetail,
  getCategoryBySlug,
  listArtifacts,
  listCategories,
  finishBenchmarkRun,
  getBlindReviewForReviewer,
  insertAgentRun,
  getJob,
  getRepositoryRegistration,
  getRepository,
  getRepositoryScan,
  importArtifactVersion,
  registerLocalRepository,
  importSuiteVersion,
  listJobs,
  upsertRepository,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  addArtifactTagAction,
  assignArtifactCategoryAction,
  assignArtifactSuiteAction,
  cancelJobAction,
  createCategoryAction,
  setCategoryArchivedAction,
  updateCategoryAction,
  recordBlindVerdictAction,
  revealBlindReviewAction,
  startBlindReviewAction,
  enqueueBenchmarkRunAction,
  registerRepositoryAction,
  removeArtifactTagAction,
  removeRepositoryAction,
  saveArtifactNotesAction,
  scanRepositoryAction,
  setCategoryForListedArtifactsAction,
  unassignArtifactCategoryAction,
  unassignArtifactSuiteAction,
} from '../lib/actions';
import {
  ARTIFACT_GONE_MESSAGE,
  INCOMPLETE_FORM_MESSAGE,
  SUITE_GONE_MESSAGE,
  metadataLimits,
  type MetadataFormState,
} from '../lib/artifact-metadata';
import {
  CATEGORY_GONE_MESSAGE,
  type BulkCategoryFormState,
  type CategoryFormState,
} from '../lib/categories';
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

  it('refuses a suite whose agent is not the mock agent, even when called directly (SPEC-118 FR-118-05)', async () => {
    const artifact = await importArtifact();
    const definition = await exampleDefinitionDocument();
    const execution = definition.execution as Record<string, unknown>;
    const suite = await importSuite(
      { ...definition, execution: { ...execution, agent: 'claude-code' } },
      'bundled-example',
    );

    const url = await redirectOf(
      enqueueBenchmarkRunAction(
        form({ suiteVersionId: suite.versionId, artifactId: artifact.artifactId }),
      ),
    );

    expect(new URL(url, 'http://localhost').searchParams.get('error')).toBe(
      'This suite uses agent "claude-code". The web UI runs only mock-agent suites; real agents run from the CLI (planned — not implemented yet).',
    );
    expect(url.startsWith(`/benchmarks/${suite.suiteId}?error=`)).toBe(true);
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
      input: '~/code/skills/',
      source: 'path',
      result: null,
    });
  });

  it('enqueues only the normalised location of a GitHub URL', async () => {
    const url = await redirectOf(
      registerRepositoryAction(form({ path: ' https://github.com/Acme/Skills.git ' })),
    );
    const jobId = new URL(url, 'http://localhost').searchParams.get('registration') as string;
    expect((await getJob(handle.db, jobId))?.payload).toEqual({
      url: 'https://github.com/acme/skills',
    });
    expect(next.revalidatePath).toHaveBeenCalledWith('/repositories');
  });

  it('rejects a URL with credentials without storing, echoing or redirecting with it', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    for (const input of [
      `https://user:${secret}@github.com/acme/skills`,
      `https://${secret}@github.com/acme/skills`,
      `https://x:${secret} y@github.com/acme/skills`,
    ]) {
      const url = await redirectOf(registerRepositoryAction(form({ path: input })));
      expect(url).toBe('/repositories?urlError=credentials-in-url');
      expect(url).not.toContain(secret);
    }
    // A token can hide in a query or fragment too (review of PR #51).
    for (const input of [
      `https://github.com/acme/skills?access_token=${secret}`,
      `https://github.com/acme/skills#${secret}`,
    ]) {
      expect(await redirectOf(registerRepositoryAction(form({ path: input })))).toBe(
        '/repositories?urlError=invalid-url',
      );
    }
    // An SSH address carries a user too: it is refused without being echoed.
    expect(
      await redirectOf(registerRepositoryAction(form({ path: 'git@github.com:a/b.git' }))),
    ).toBe('/repositories?urlError=unsupported-provider');
    expect(jobCount()).toBe(0);
  });

  it('never echoes a malformed URL that may carry a token, whichever branch rejects it', async () => {
    // Codex review round 2 of PR #51: these are not recognised as URLs, fell through to path
    // validation and were echoed in `?path=`.
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const cases: [string, string][] = [
      [`https:/github.com/acme/repo?access_token=${secret}`, 'not-echoed'],
      [`https:github.com/acme/repo?access_token=${secret}`, 'not-echoed'],
      [`http//user:${secret}@github.com/acme/repo`, 'not-echoed'],
      [`HTTPS:\\\\github.com\\acme\\repo?token=${secret}`, 'not-echoed'],
      [`github.com/acme/repo?token=${secret}`, 'not-echoed'],
      [`github.com/acme/repo#${secret}`, 'not-echoed'],
      [`https:/github.com/acme/repo%3Faccess_token%3D${secret}`, 'not-echoed'],
      [`code/skills@${secret}`, 'not-echoed'],
      [`x-access-token:${secret}@github.com:acme/repo.git`, 'unsupported-provider'],
      [`https://github.com/acme/repo%3Ftoken%3D${secret}`, 'invalid-url'],
      // Valid absolute paths that read as protocol-relative URLs (independent review).
      [` //github.com/acme/repo?access_token=${secret}`, 'invalid-url'],
      [`\\\\user:${secret}@github.com\\acme\\repo`, 'invalid-url'],
      // Double encoding and fullwidth lookalikes are not echoed either.
      [`https:/github.com/acme/repo%253Ftoken%253D${secret}`, 'not-echoed'],
      [`https://u:${secret}\uFF20github.com/acme/repo`, 'invalid-url'],
    ];
    for (const [input, code] of cases) {
      const url = await redirectOf(registerRepositoryAction(form({ path: input })));
      expect(url).toBe(`/repositories?urlError=${code}`);
      expect(url).not.toContain(secret.slice(4, 12));
    }
    expect(jobCount()).toBe(0);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('still registers a valid local path with @, ? or #, or a leading //', async () => {
    for (const path of ['/srv/team@skills', '~/notes/a@b?c#d', '//srv/share/skills']) {
      const url = await redirectOf(registerRepositoryAction(form({ path })));
      const jobId = new URL(url, 'http://localhost').searchParams.get('registration') as string;
      expect(url).toBe(`/repositories?registration=${jobId}`);
      expect((await getJob(handle.db, jobId))?.payload).toEqual({ path });
    }
  });

  it('returns an unsupported URL without credentials to the form', async () => {
    const url = await redirectOf(
      registerRepositoryAction(form({ path: ` https://gitlab.com/acme/${'x'.repeat(3000)} ` })),
    );
    const params = new URL(url, 'http://localhost').searchParams;
    expect([...params.keys()]).toEqual(['path']);
    expect(params.get('path')).toBe(`https://gitlab.com/acme/${'x'.repeat(3000)}`.slice(0, 2049));
    expect(jobCount()).toBe(0);
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

  it('echoes an overlong path only up to one character over the limit', async () => {
    const long = `/${'a'.repeat(20_000)}`;
    const params = new URL(
      await redirectOf(registerRepositoryAction(form({ path: long }))),
      'http://localhost',
    ).searchParams;
    expect(params.get('path')).toBe(long.slice(0, MAX_REPOSITORY_PATH_LENGTH + 1));
    expect(jobCount()).toBe(0);
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

  it('passes a confirmed canonical location to the runner (FR-104-18)', async () => {
    const url = await redirectOf(
      registerRepositoryAction(form({ path: '~', confirmedLocation: '/home/me ' })),
    );
    const jobId = new URL(url, 'http://localhost').searchParams.get('registration') as string;
    expect((await getJob(handle.db, jobId))?.payload).toEqual({
      path: '~',
      confirmedLocation: '/home/me ',
    });
  });

  it('drops an invalid confirmed location, so the runner asks again', async () => {
    const url = await redirectOf(
      registerRepositoryAction(form({ path: '/srv', confirmedLocation: 'relative' })),
    );
    const jobId = new URL(url, 'http://localhost').searchParams.get('registration') as string;
    expect((await getJob(handle.db, jobId))?.payload).toEqual({ path: '/srv' });
  });
});

describe('scanRepositoryAction', () => {
  async function localRepository(): Promise<string> {
    const outcome = await registerLocalRepository(
      handle,
      { provider: 'local-directory', name: 'skills', location: '/srv/skills', defaultBranch: null },
      { homeDirectory: '/home/me', confirmedLocation: null },
    );
    if (outcome.status !== 'registered') throw new Error('not registered');
    return outcome.repository.id;
  }

  it('enqueues one scan and shows it on the Repositories page', async () => {
    const repositoryId = await localRepository();
    const url = await redirectOf(scanRepositoryAction(form({ repositoryId })));
    const jobId = new URL(url, 'http://localhost').searchParams.get('scan') as string;
    expect(url).toBe(`/repositories?scan=${jobId}`);
    expect(next.revalidatePath).toHaveBeenCalledWith('/repositories');
    expect(await getRepositoryScan(handle.db, jobId)).toMatchObject({
      status: 'pending',
      repositoryId,
    });
    // A second click returns the scan that is already pending.
    expect(await redirectOf(scanRepositoryAction(form({ repositoryId })))).toBe(url);
  });

  it('returns to the page with an error for a missing, unknown or non-local repository', async () => {
    expect(await redirectOf(scanRepositoryAction(form({})))).toBe(
      '/repositories?scanError=invalid',
    );
    expect(await redirectOf(scanRepositoryAction(form({ repositoryId: 'repo_missing' })))).toBe(
      '/repositories?scanError=not-found',
    );
    await upsertRepository(handle.db, {
      provider: 'bundled-examples',
      name: 'Bundled',
      location: '/opt/examples',
    });
    const bundled = handle.sqlite
      .prepare("select id from repositories where provider = 'bundled-examples'")
      .get() as { id: string };
    expect(await redirectOf(scanRepositoryAction(form({ repositoryId: bundled.id })))).toBe(
      '/repositories?scanError=unsupported',
    );
    expect(
      Number((handle.sqlite.prepare('select count(*) as n from jobs').get() as { n: number }).n),
    ).toBe(0);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('still fails loudly on an unexpected database error', async () => {
    const repositoryId = await localRepository();
    handle.sqlite.exec(
      "CREATE TRIGGER fail_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(scanRepositoryAction(form({ repositoryId }))).rejects.toThrow();
    expect(next.redirect).not.toHaveBeenCalled();
  });
});

describe('removeRepositoryAction (SPEC-125 FR-125-16)', () => {
  it('removes the repository, keeps its artifact and returns with the counts', async () => {
    const { artifactId } = await importArtifact();
    const repositoryId = (
      handle.sqlite.prepare('select id from repositories').get() as { id: string }
    ).id;
    expect(await redirectOf(removeRepositoryAction(form({ repositoryId })))).toBe(
      '/repositories?removedOccurrences=1&missingArtifacts=1#remove-result',
    );
    expect(await getRepository(handle.db, repositoryId)).toBeNull();
    expect(await getArtifactDetail(handle.db, artifactId)).toMatchObject({
      missing: true,
      lastFoundAt: null,
    });
    expect(next.revalidatePath.mock.calls).toEqual([
      ['/repositories'],
      ['/artifacts', 'layout'],
      ['/categories', 'layout'],
      ['/'],
    ]);
    // Posting again (a double submit) finds nothing to remove.
    expect(await redirectOf(removeRepositoryAction(form({ repositoryId })))).toBe(
      '/repositories?removeError=not-found',
    );
  });

  it('returns with an error for missing input and for the bundled examples, writing nothing', async () => {
    expect(await redirectOf(removeRepositoryAction(form({})))).toBe(
      '/repositories?removeError=invalid',
    );
    const bundled = await upsertRepository(handle.db, {
      provider: 'bundled-examples',
      name: 'Bundled',
      location: '/opt/examples',
    });
    expect(await redirectOf(removeRepositoryAction(form({ repositoryId: bundled })))).toBe(
      '/repositories?removeError=invalid',
    );
    expect(await getRepository(handle.db, bundled)).not.toBeNull();
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports a failed transaction without its error text and changes nothing', async () => {
    await importArtifact();
    const repositoryId = (
      handle.sqlite.prepare('select id from repositories').get() as { id: string }
    ).id;
    handle.sqlite.exec(
      "CREATE TRIGGER fail_occurrences BEFORE DELETE ON artifact_occurrences BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(await redirectOf(removeRepositoryAction(form({ repositoryId })))).toBe(
      '/repositories?removeError=failed',
    );
    expect(await getRepository(handle.db, repositoryId)).not.toBeNull();
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('artifact metadata actions (issue #64)', () => {
  const idle: MetadataFormState = { kind: 'idle' };

  async function storedArtifact(artifactId: string) {
    return handle.sqlite
      .prepare('select tags, notes from artifacts where id = ?')
      .get(artifactId) as { tags: string; notes: string | null };
  }

  function failArtifactUpdates(): void {
    handle.sqlite.exec(
      "CREATE TRIGGER fail_artifacts BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
  }

  it('adds a trimmed, lower-cased tag once and refreshes the page', async () => {
    const { artifactId } = await importArtifact();
    expect(await addArtifactTagAction(idle, form({ artifactId, tag: '  Security ' }))).toEqual({
      kind: 'success',
      message: 'Added tag security.',
    });
    expect(next.revalidatePath).toHaveBeenCalledWith(`/artifacts/${artifactId}`);
    expect(await addArtifactTagAction(idle, form({ artifactId, tag: 'SECURITY' }))).toEqual({
      kind: 'success',
      message: 'security is already a tag.',
    });
    expect(JSON.parse((await storedArtifact(artifactId)).tags)).toEqual(['security']);
  });

  it('keeps an invalid tag in the field with a message', async () => {
    const { artifactId } = await importArtifact();
    const long = 'x'.repeat(metadataLimits.tagLength + 1);
    const cases: Array<[string, string]> = [
      ['   ', 'Enter a tag.'],
      [long, 'A tag can be at most 64 characters. Shorten it.'],
      ['a, b', 'A tag cannot contain a comma. Add each tag on its own.'],
      ['a\tb', 'A tag cannot contain line breaks or other control characters.'],
    ];
    for (const [tag, message] of cases) {
      expect(await addArtifactTagAction(idle, form({ artifactId, tag }))).toEqual({
        kind: 'fieldError',
        message,
        value: tag,
      });
    }
    const upload = form({ artifactId });
    upload.set('tag', new File(['x'], 'tag.txt'));
    expect(await addArtifactTagAction(idle, upload)).toEqual({
      kind: 'fieldError',
      message: 'Enter a tag.',
      value: '',
    });
    expect(JSON.parse((await storedArtifact(artifactId)).tags)).toEqual([]);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a tag over the limit and names how to continue', async () => {
    const { artifactId } = await importArtifact();
    for (let i = 0; i < metadataLimits.tags; i++) {
      await addArtifactTagAction(idle, form({ artifactId, tag: `tag-${i}` }));
    }
    expect(await addArtifactTagAction(idle, form({ artifactId, tag: 'more' }))).toEqual({
      kind: 'fieldError',
      message: 'An artifact can have at most 32 tags. Remove one first.',
      value: 'more',
    });
  });

  it('removes a tag and reports one that was already removed', async () => {
    const { artifactId } = await importArtifact();
    await addArtifactTagAction(idle, form({ artifactId, tag: 'security' }));
    expect(await removeArtifactTagAction(idle, form({ artifactId, tag: 'security' }))).toEqual({
      kind: 'success',
      message: 'Removed tag security.',
    });
    expect(await removeArtifactTagAction(idle, form({ artifactId, tag: 'security' }))).toEqual({
      kind: 'success',
      message: 'security was already removed.',
    });
    expect(JSON.parse((await storedArtifact(artifactId)).tags)).toEqual([]);
  });

  it('saves notes with LF line breaks and clears empty notes', async () => {
    const { artifactId } = await importArtifact();
    expect(
      await saveArtifactNotesAction(idle, form({ artifactId, notes: 'one\r\ntwo\rthree ' })),
    ).toEqual({ kind: 'success', message: 'Saved the notes.' });
    expect((await storedArtifact(artifactId)).notes).toBe('one\ntwo\nthree ');
    expect(await saveArtifactNotesAction(idle, form({ artifactId, notes: ' \r\n ' }))).toEqual({
      kind: 'success',
      message: 'Cleared the notes.',
    });
    expect((await storedArtifact(artifactId)).notes).toBeNull();
    expect(next.revalidatePath).toHaveBeenCalledWith(`/artifacts/${artifactId}`);
  });

  it('keeps notes over the limit in the field', async () => {
    const { artifactId } = await importArtifact();
    // CR LF counts as one character, as the browser counts it for maxLength.
    const notes = `${'x'.repeat(metadataLimits.notesLength - 1)}\r\n`;
    expect(await saveArtifactNotesAction(idle, form({ artifactId, notes }))).toEqual({
      kind: 'success',
      message: 'Saved the notes.',
    });
    const tooLong = 'x'.repeat(metadataLimits.notesLength + 1);
    expect(await saveArtifactNotesAction(idle, form({ artifactId, notes: tooLong }))).toEqual({
      kind: 'fieldError',
      message: 'Notes can be at most 10,000 characters. Shorten them.',
      value: tooLong,
    });
    const upload = form({ artifactId });
    upload.set('notes', new File(['x'], 'notes.txt'));
    expect(await saveArtifactNotesAction(idle, upload)).toEqual({
      kind: 'fieldError',
      message: 'Enter the notes as text.',
      value: '',
    });
  });

  it('answers a missing or altered hidden field with a general error', async () => {
    const { artifactId, suiteId } = {
      ...(await importArtifact()),
      ...(await importSuite({}, null)),
    };
    const incomplete = { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
    expect(await addArtifactTagAction(idle, form({ tag: 'x' }))).toEqual(incomplete);
    expect(await addArtifactTagAction(idle, form({ artifactId: '', tag: '' }))).toEqual(incomplete);
    expect(await removeArtifactTagAction(idle, form({ artifactId }))).toEqual(incomplete);
    expect(await saveArtifactNotesAction(idle, form({ notes: 'x' }))).toEqual(incomplete);
    expect(await assignArtifactSuiteAction(idle, form({ artifactId }))).toEqual(incomplete);
    expect(await unassignArtifactSuiteAction(idle, form({ suiteId }))).toEqual(incomplete);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('says when the artifact no longer exists', async () => {
    const gone = { kind: 'error', message: ARTIFACT_GONE_MESSAGE };
    const { suiteId } = await importSuite({}, null);
    const artifactId = 'art_missing';
    expect(await addArtifactTagAction(idle, form({ artifactId, tag: 'x' }))).toEqual(gone);
    expect(await removeArtifactTagAction(idle, form({ artifactId, tag: 'x' }))).toEqual(gone);
    expect(await saveArtifactNotesAction(idle, form({ artifactId, notes: 'x' }))).toEqual(gone);
    expect(await assignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual(gone);
    expect(await unassignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual(gone);
  });

  it('still fails loudly on an unexpected database error', async () => {
    const { artifactId } = await importArtifact();
    failArtifactUpdates();
    await expect(addArtifactTagAction(idle, form({ artifactId, tag: 'x' }))).rejects.toThrow();
    await expect(saveArtifactNotesAction(idle, form({ artifactId, notes: 'x' }))).rejects.toThrow();
  });

  it('assigns and unassigns a suite by name and keeps its results', async () => {
    const { artifactId } = await importArtifact();
    const { suiteId } = await importSuite({}, null);
    expect(await assignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual({
      kind: 'success',
      message: 'Assigned Input validation. Run it from its suite page.',
    });
    expect(await assignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual({
      kind: 'success',
      message: 'Input validation is already assigned.',
    });
    expect(await unassignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual({
      kind: 'success',
      message: 'Unassigned Input validation. Its results stay in Results by version.',
    });
    expect(await unassignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual({
      kind: 'success',
      message: 'Input validation was already unassigned.',
    });
    expect(next.revalidatePath).toHaveBeenCalledWith(`/artifacts/${artifactId}`);
  });

  it('says when the suite no longer exists', async () => {
    const { artifactId } = await importArtifact();
    const gone = { kind: 'error', message: SUITE_GONE_MESSAGE };
    const suiteId = 'suite_missing';
    expect(await assignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual(gone);
    expect(await unassignArtifactSuiteAction(idle, form({ artifactId, suiteId }))).toEqual(gone);
  });
});

describe('blind review actions (SPEC-123 §10)', () => {
  const idle: MetadataFormState = { kind: 'idle' };

  /** A benchmark run with one pair of completed agent runs with kept files; `status` sets it. */
  async function seededRun(status: 'running' | 'completed' = 'completed'): Promise<string> {
    const { versionId: artifactVersionId } = await importArtifact();
    const { versionId: suiteVersionId } = await importSuite({ id: 'suite' }, null);
    const runId = await createBenchmarkRun(handle.db, {
      jobId: null,
      suiteVersionId,
      artifactVersionId,
      baselineArtifactVersionId: null,
      agentAdapterId: 'mock',
      agentVersion: null,
      model: null,
      environment: {},
    });
    for (const variant of ['baseline', 'candidate'] as const) {
      await insertAgentRun(handle, {
        benchmarkRunId: runId,
        caseId: 'case-a',
        variant,
        repetition: 1,
        fixtureVersionId: 'f',
        executionStatus: 'completed',
        score: 1,
        passed: true,
        durationMs: 1,
        changedFiles: [],
        trace: [],
        usage: null,
        error: null,
        assertions: [],
        outputFilesKept: true,
        outputFilesReason: null,
        outputFiles: [],
      });
    }
    if (status === 'completed') {
      await finishBenchmarkRun(handle.db, runId, {
        status: 'completed',
        verdict: null,
        summary: null,
        comparabilityKey: null,
        warnings: [],
        error: null,
      });
    }
    return runId;
  }

  async function startedReview() {
    const runId = await seededRun();
    await redirectOf(startBlindReviewAction(idle, form({ benchmarkRunId: runId })));
    const view = (await getBlindReviewForReviewer(handle.db, runId))!;
    return { runId, reviewId: view.review.id, pairId: view.pairs[0]!.id };
  }

  it('starts a review, or opens the existing one, on its own page', async () => {
    const runId = await seededRun();
    const url = `/results/${runId}/blind-review`;
    expect(await redirectOf(startBlindReviewAction(idle, form({ benchmarkRunId: runId })))).toBe(
      url,
    );
    expect(await redirectOf(startBlindReviewAction(idle, form({ benchmarkRunId: runId })))).toBe(
      url,
    );
    expect(next.revalidatePath).toHaveBeenCalledWith(`/results/${runId}`, 'layout');
    expect((await getBlindReviewForReviewer(handle.db, runId))!.pairs).toHaveLength(1);
  });

  it('refuses a forged start with the reason, without a review', async () => {
    const running = await seededRun('running');
    expect(await startBlindReviewAction(idle, form({ benchmarkRunId: running }))).toEqual({
      kind: 'error',
      message: 'A blind review can start only after the run has completed.',
    });
    expect(await startBlindReviewAction(idle, form({ benchmarkRunId: 'run_missing' }))).toEqual({
      kind: 'error',
      message: 'This benchmark run no longer exists.',
    });
    expect(await startBlindReviewAction(idle, form({}))).toEqual({
      kind: 'error',
      message: INCOMPLETE_FORM_MESSAGE,
    });
    expect(next.redirect).not.toHaveBeenCalled();
    expect(await getBlindReviewForReviewer(handle.db, running)).toBeNull();
  });

  it('records one verdict per pair and refuses a second one', async () => {
    const { runId, pairId } = await startedReview();
    const verdict = (fields: Record<string, string>) =>
      recordBlindVerdictAction(idle, form({ benchmarkRunId: runId, pairId, ...fields }));
    expect(await verdict({ verdict: 'a', note: '  Clearer.\r\nShorter.  ' })).toEqual({
      kind: 'success',
      message: 'Verdict recorded.',
    });
    expect(await verdict({ verdict: 'b', note: '' })).toEqual({
      kind: 'error',
      message: 'This pair already has a verdict.',
    });
    expect((await getBlindReviewForReviewer(handle.db, runId))!.pairs[0]).toMatchObject({
      verdict: 'a',
      note: '  Clearer.\nShorter.  ',
    });
    expect(next.revalidatePath).toHaveBeenCalledWith(`/results/${runId}`, 'layout');
  });

  it("refuses a verdict or a reveal posted with another run's pair or review and changes nothing (issue #170)", async () => {
    const own = await startedReview();
    const other = await startedReview();
    const stored = async () => [
      await getBlindReviewForReviewer(handle.db, own.runId),
      await getBlindReviewForReviewer(handle.db, other.runId),
    ];
    const before = await stored();
    expect(
      await recordBlindVerdictAction(
        idle,
        form({ benchmarkRunId: own.runId, pairId: other.pairId, verdict: 'a', note: 'forged' }),
      ),
    ).toEqual({ kind: 'error', message: 'This pair belongs to another benchmark run.' });
    expect(
      await revealBlindReviewAction(
        idle,
        form({ benchmarkRunId: own.runId, reviewId: other.reviewId }),
      ),
    ).toEqual({ kind: 'error', message: 'This review belongs to another benchmark run.' });
    expect(await stored()).toEqual(before);
    expect(before.map((view) => view!.review.revealedAt)).toEqual([null, null]);
    expect(before.flatMap((view) => view!.pairs.map((pair) => pair.verdict))).toEqual([null, null]);
  });

  it('stores a missing or blank note as no note, and keeps an overlong note in the form', async () => {
    const { runId, pairId } = await startedReview();
    const long = 'x'.repeat(2_001);
    expect(
      await recordBlindVerdictAction(
        idle,
        form({ benchmarkRunId: runId, pairId, verdict: 'tie', note: long }),
      ),
    ).toEqual({
      kind: 'fieldError',
      message: 'A note can be at most 2,000 characters. Shorten it.',
      value: long,
    });
    expect(
      await recordBlindVerdictAction(idle, form({ benchmarkRunId: runId, pairId, verdict: 'tie' })),
    ).toEqual({ kind: 'success', message: 'Verdict recorded.' });
    expect((await getBlindReviewForReviewer(handle.db, runId))!.pairs[0]!.note).toBeNull();
  });

  it('refuses an unknown verdict or a missing pair as an incomplete form', async () => {
    const { runId, pairId } = await startedReview();
    const forged: Record<string, string>[] = [{ pairId, verdict: 'baseline' }, { verdict: 'a' }];
    for (const fields of forged) {
      expect(
        await recordBlindVerdictAction(idle, form({ benchmarkRunId: runId, note: '', ...fields })),
      ).toEqual({ kind: 'error', message: INCOMPLETE_FORM_MESSAGE });
    }
  });

  it('reveals the review once and closes verdicts', async () => {
    const { runId, reviewId, pairId } = await startedReview();
    const reveal = (id: string) =>
      revealBlindReviewAction(idle, form({ benchmarkRunId: runId, reviewId: id }));
    expect(await reveal(reviewId)).toEqual({
      kind: 'success',
      message: 'Variants revealed. The blind review has ended.',
    });
    expect(await reveal(reviewId)).toEqual({
      kind: 'success',
      message: 'This review was already revealed.',
    });
    expect(await reveal('brev_missing')).toEqual({
      kind: 'error',
      message: 'This review no longer exists.',
    });
    expect(await revealBlindReviewAction(idle, form({ reviewId }))).toEqual({
      kind: 'error',
      message: INCOMPLETE_FORM_MESSAGE,
    });
    expect(
      await recordBlindVerdictAction(
        idle,
        form({ benchmarkRunId: runId, pairId, verdict: 'a', note: '' }),
      ),
    ).toEqual({ kind: 'error', message: 'This review was revealed; verdicts are closed.' });
    expect(
      await recordBlindVerdictAction(
        idle,
        form({ benchmarkRunId: runId, pairId: 'bpair_missing', verdict: 'a', note: '' }),
      ),
    ).toEqual({ kind: 'error', message: 'This pair no longer exists.' });
  });
});

describe('category actions (SPEC-124 §10)', () => {
  const idle: CategoryFormState = { kind: 'idle' };

  async function categoryRows() {
    return (await listCategories(handle.db)).map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      archived: c.archivedAt !== null,
    }));
  }

  async function create(name: string, description = ''): Promise<string> {
    expect(await createCategoryAction(idle, form({ name, description }))).toMatchObject({
      kind: 'success',
    });
    const slug = (await categoryRows()).find((c) => c.name === name.trim())?.slug;
    const category = await getCategoryBySlug(handle.db, slug as string);
    return (category as { id: string }).id;
  }

  function expectRefreshed(): void {
    expect(next.revalidatePath).toHaveBeenCalledWith('/categories', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledWith('/artifacts', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledTimes(2);
  }

  it('creates a category and refreshes the category and artifact pages', async () => {
    expect(
      await createCategoryAction(idle, form({ name: '  Client   A ', description: ' Ours ' })),
    ).toEqual({ kind: 'success', message: 'Created Client A.' });
    expectRefreshed();
    expect(await categoryRows()).toEqual([
      { slug: 'client-a', name: 'Client A', description: 'Ours', archived: false },
    ]);
    // A name without a Latin letter or digit gets a generated slug (A5).
    expect(await createCategoryAction(idle, form({ name: '日本語', description: '' }))).toEqual({
      kind: 'success',
      message: 'Created 日本語.',
    });
    expect(await getCategoryBySlug(handle.db, 'category-1')).toMatchObject({
      name: '日本語',
      description: null,
    });
  });

  it('refuses invalid, duplicate and slug-taken names with both values kept, storing nothing', async () => {
    await create('Testing');
    vi.clearAllMocks();
    const before = await categoryRows();
    const cases: Array<[Record<string, string>, string]> = [
      [{ name: '', description: 'd' }, 'Enter a name.'],
      [
        { name: 'two\nlines', description: 'd' },
        'A name cannot contain line breaks or other control characters.',
      ],
      [
        { name: 'x'.repeat(65), description: 'd' },
        'A name can be at most 64 characters. Shorten it.',
      ],
      [
        { name: ' TESTING ', description: 'd' },
        'A category named Testing already exists. Choose another name.',
      ],
    ];
    for (const [fields, message] of cases) {
      expect(await createCategoryAction(idle, form(fields)), message).toEqual({
        kind: 'fieldError',
        message,
        field: 'name',
        values: fields,
      });
    }
    expect(
      await createCategoryAction(idle, form({ name: 'Ok', description: 'x'.repeat(501) })),
    ).toEqual({
      kind: 'fieldError',
      message: 'A description can be at most 500 characters. Shorten it.',
      field: 'description',
      values: { name: 'Ok', description: 'x'.repeat(501) },
    });
    // A missing field is not something the user typed: a general error, with empty values.
    expect(await createCategoryAction(idle, form({ name: 'Ok' }))).toEqual({
      kind: 'error',
      message: INCOMPLETE_FORM_MESSAGE,
    });
    expect(await categoryRows()).toEqual(before);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('names the holder of a taken slug, and says to unarchive an archived one', async () => {
    const pythonId = await create('Python');
    await create('C');
    expect(await createCategoryAction(idle, form({ name: 'C#', description: '' }))).toMatchObject({
      message: 'The name gives the link c, which C already uses. Choose another name.',
    });
    await setCategoryArchivedAction(idle, form({ id: pythonId, intent: 'archive' }));
    expect(
      await createCategoryAction(idle, form({ name: 'python', description: '' })),
    ).toMatchObject({
      kind: 'fieldError',
      message:
        'The archived category Python already uses the link python. Unarchive it on its page instead.',
    });
  });

  it('renames a category, keeping its slug, and reports a description change or no change', async () => {
    const id = await create('DevOps', 'Old');
    vi.clearAllMocks();
    expect(
      await updateCategoryAction(idle, form({ id, name: 'CI and Ops', description: 'Old' })),
    ).toEqual({
      kind: 'success',
      message: 'Renamed to CI and Ops. Its slug stays devops, so links keep working.',
    });
    expectRefreshed();
    vi.clearAllMocks();
    expect(
      await updateCategoryAction(idle, form({ id, name: 'CI and Ops', description: 'New' })),
    ).toEqual({ kind: 'success', message: 'Saved.' });
    vi.clearAllMocks();
    expect(
      await updateCategoryAction(idle, form({ id, name: ' CI  and Ops', description: 'New ' })),
    ).toEqual({ kind: 'success', message: 'Nothing changed.' });
    expect(next.revalidatePath).not.toHaveBeenCalled();
    expect(await categoryRows()).toEqual([
      { slug: 'devops', name: 'CI and Ops', description: 'New', archived: false },
    ]);
  });

  it('refuses a rename into another active name, a forged id and invalid input', async () => {
    const id = await create('Python');
    await create('Testing');
    const before = await categoryRows();
    vi.clearAllMocks();
    expect(
      await updateCategoryAction(idle, form({ id, name: 'testing', description: '' })),
    ).toEqual({
      kind: 'fieldError',
      message: 'A category named Testing already exists. Choose another name.',
      field: 'name',
      values: { name: 'testing', description: '' },
    });
    expect(
      await updateCategoryAction(idle, form({ id: 'cat_forged', name: 'New', description: '' })),
    ).toEqual({ kind: 'error', message: CATEGORY_GONE_MESSAGE });
    expect(await updateCategoryAction(idle, form({ name: 'New', description: '' }))).toEqual({
      kind: 'error',
      message: INCOMPLETE_FORM_MESSAGE,
    });
    expect(
      await updateCategoryAction(idle, form({ id, name: 'New', description: 'tab\there' })),
    ).toMatchObject({ kind: 'fieldError', field: 'description' });
    expect(await categoryRows()).toEqual(before);
    expect(next.revalidatePath).not.toHaveBeenCalled();
  });

  it('archives with the artifact count, unarchives, and is idempotent', async () => {
    const id = await create('Python');
    const { artifactId } = await importArtifact();
    await assignArtifactCategory(handle, artifactId, id);
    vi.clearAllMocks();
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'archive' }))).toEqual({
      kind: 'success',
      message: 'Archived Python. It stays on 1 artifact.',
    });
    expectRefreshed();
    vi.clearAllMocks();
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'archive' }))).toEqual({
      kind: 'success',
      message: 'Python is already archived.',
    });
    // Another tab archived it: this tab's page is refreshed to show the real state.
    expectRefreshed();
    vi.clearAllMocks();
    // Assignments stay (FR-124-08).
    expect(await getCategoryBySlug(handle.db, 'python')).toMatchObject({
      archived: true,
      artifactCount: 1,
    });
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'unarchive' }))).toEqual({
      kind: 'success',
      message: 'Unarchived Python. It is back in pickers and filters.',
    });
    expectRefreshed();
    vi.clearAllMocks();
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'unarchive' }))).toEqual({
      kind: 'success',
      message: 'Python is already active.',
    });
    expectRefreshed();
    const empty = await create('Empty');
    expect(await setCategoryArchivedAction(idle, form({ id: empty, intent: 'archive' }))).toEqual({
      kind: 'success',
      message: 'Archived Empty.',
    });
  });

  it('refuses an unarchive clash, a forged id and a forged intent', async () => {
    const id = await create('Python');
    await setCategoryArchivedAction(idle, form({ id, intent: 'archive' }));
    // The archived name is free for an active category (A10), under another slug.
    const snake = await create('Snake');
    await updateCategoryAction(idle, form({ id: snake, name: 'PYTHON', description: '' }));
    vi.clearAllMocks();
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'unarchive' }))).toEqual({
      kind: 'error',
      message: 'An active category is already named PYTHON. Rename one of them first.',
    });
    expect(
      await setCategoryArchivedAction(idle, form({ id: 'cat_forged', intent: 'archive' })),
    ).toEqual({ kind: 'error', message: CATEGORY_GONE_MESSAGE });
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'delete' }))).toEqual({
      kind: 'error',
      message: INCOMPLETE_FORM_MESSAGE,
    });
    expect(next.revalidatePath).not.toHaveBeenCalled();
    expect(await getCategoryBySlug(handle.db, 'python')).toMatchObject({ archived: true });
  });

  it('reports no artifact when the archived category is gone before its count is read', async () => {
    const id = await create('Python');
    // A category is never deleted by the app (A9); a trigger stands for any outside write.
    handle.sqlite.exec(
      `create trigger drop_archived after update of archived_at on categories
         when new.archived_at is not null
       begin delete from categories where id = new.id; end`,
    );
    expect(await setCategoryArchivedAction(idle, form({ id, intent: 'archive' }))).toEqual({
      kind: 'success',
      message: 'Archived Python.',
    });
  });
});

describe('artifact category actions (SPEC-124 Phase 3, §11.3)', () => {
  const idle: MetadataFormState = { kind: 'idle' };
  const categoryIdle: CategoryFormState = { kind: 'idle' };

  async function create(name: string): Promise<string> {
    await createCategoryAction(categoryIdle, form({ name, description: '' }));
    const created = (await listCategories(handle.db)).find((c) => c.name === name);
    return (created as { id: string }).id;
  }

  async function chips(artifactId: string) {
    return (await getArtifactDetail(handle.db, artifactId))?.categories.map((c) =>
      c.archived ? `${c.name} (archived)` : c.name,
    );
  }

  /** Every submit refreshes the artifact page and both layouts, whatever its outcome (D26). */
  function expectRefreshed(artifactId: string): void {
    expect(next.revalidatePath).toHaveBeenCalledWith(`/artifacts/${artifactId}`);
    expect(next.revalidatePath).toHaveBeenCalledWith('/categories', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledWith('/artifacts', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledTimes(3);
    vi.clearAllMocks();
  }

  it('assigns once and removes once, each a status, never an error (D24)', async () => {
    const { artifactId } = await importArtifact();
    const categoryId = await create('Documentation');
    vi.clearAllMocks();
    const fields = form({ artifactId, categoryId });
    expect(await assignArtifactCategoryAction(idle, fields)).toEqual({
      kind: 'success',
      message: 'Assigned Documentation.',
    });
    expectRefreshed(artifactId);
    expect(await assignArtifactCategoryAction(idle, fields)).toEqual({
      kind: 'success',
      message: 'Documentation is already assigned.',
    });
    expectRefreshed(artifactId);
    expect(await chips(artifactId)).toEqual(['Documentation']);
    expect(await unassignArtifactCategoryAction(idle, fields)).toEqual({
      kind: 'success',
      message: 'Removed Documentation.',
    });
    expectRefreshed(artifactId);
    expect(await unassignArtifactCategoryAction(idle, fields)).toEqual({
      kind: 'success',
      message: 'Documentation was already removed.',
    });
    expectRefreshed(artifactId);
    expect(await chips(artifactId)).toEqual([]);
  });

  it('names the category as it is now when another tab renamed it', async () => {
    const { artifactId } = await importArtifact();
    const categoryId = await create('Documentation');
    await updateCategoryAction(
      categoryIdle,
      form({ id: categoryId, name: 'Docs', description: '' }),
    );
    expect(await assignArtifactCategoryAction(idle, form({ artifactId, categoryId }))).toEqual({
      kind: 'success',
      message: 'Assigned Docs.',
    });
  });

  it('refuses to assign an archived category but removes it with the way back (D23)', async () => {
    const { artifactId } = await importArtifact();
    const python = await create('Python');
    const ruby = await create('Ruby');
    await assignArtifactCategory(handle, artifactId, python);
    for (const id of [python, ruby]) {
      await setCategoryArchivedAction(categoryIdle, form({ id, intent: 'archive' }));
    }
    vi.clearAllMocks();
    expect(
      await assignArtifactCategoryAction(idle, form({ artifactId, categoryId: ruby })),
    ).toEqual({
      kind: 'error',
      message: 'Ruby is archived. Unarchive it on its page before assigning it.',
    });
    // The refused option leaves this stale page's picker on the refresh (D26).
    expectRefreshed(artifactId);
    expect(await chips(artifactId)).toEqual(['Python (archived)']);
    expect(
      await unassignArtifactCategoryAction(idle, form({ artifactId, categoryId: python })),
    ).toEqual({
      kind: 'success',
      message: 'Removed Python. To assign it again, unarchive it on its page first.',
    });
    expectRefreshed(artifactId);
    expect(await chips(artifactId)).toEqual([]);
  });

  it('refuses forged or missing ids and writes nothing', async () => {
    const { artifactId } = await importArtifact();
    const categoryId = await create('Documentation');
    vi.clearAllMocks();
    for (const action of [assignArtifactCategoryAction, unassignArtifactCategoryAction]) {
      const forms: Record<string, string>[] = [
        { artifactId },
        { categoryId },
        { artifactId, categoryId: '' },
      ];
      for (const fields of forms) {
        expect(await action(idle, form(fields)), JSON.stringify(fields)).toEqual({
          kind: 'error',
          message: INCOMPLETE_FORM_MESSAGE,
        });
        // Without a valid artifact id only the layouts are refreshed; they cover its page.
        expect(next.revalidatePath).toHaveBeenCalledWith('/categories', 'layout');
        expect(next.revalidatePath).toHaveBeenCalledWith('/artifacts', 'layout');
        expect(next.revalidatePath).toHaveBeenCalledTimes(2);
        vi.clearAllMocks();
      }
      expect(await action(idle, form({ artifactId, categoryId: 'cat_forged' }))).toEqual({
        kind: 'error',
        message: CATEGORY_GONE_MESSAGE,
      });
      expectRefreshed(artifactId);
      expect(await action(idle, form({ artifactId: 'art_forged', categoryId }))).toEqual({
        kind: 'error',
        message: ARTIFACT_GONE_MESSAGE,
      });
      expectRefreshed('art_forged');
    }
    expect(await chips(artifactId)).toEqual([]);
    expect((await listCategories(handle.db)).map((c) => c.artifactCount)).toEqual([0]);
  });
});

describe('bulk category action (SPEC-124 Phase 4, FR-124-13)', () => {
  const idle: BulkCategoryFormState = { kind: 'idle' };
  const categoryIdle: CategoryFormState = { kind: 'idle' };

  async function create(name: string): Promise<string> {
    await createCategoryAction(categoryIdle, form({ name, description: '' }));
    const created = (await listCategories(handle.db)).find((c) => c.name === name);
    return (created as { id: string }).id;
  }

  async function addArtifact(slug: string, type: 'skill' | 'rule' = 'skill'): Promise<string> {
    const { artifactId } = await importArtifactVersion(handle, {
      repository: { provider: 'local-directory', name: 'tests', location: dataDir.root },
      path: `skills/${slug}`,
      slug,
      name: slug,
      type,
      description: null,
      format: 'skill-md',
      primaryFile: 'SKILL.md',
      files: [{ path: 'SKILL.md', sha256: 'abc', size: 5, content: 'hello' }],
      parsedMetadata: {},
    });
    return artifactId;
  }

  /** The form as the page posts it: every list key, the mode, the category and the fingerprint. */
  async function bulk(
    categoryId: string,
    mode: string,
    filter: { q?: string; type?: 'skill' | 'rule' } = {},
    overrides: Record<string, string> = {},
  ): Promise<FormData> {
    const ids = (await listArtifacts(handle.db, filter)).map((a) => a.id);
    return form({
      categoryId,
      mode,
      listFingerprint: idListFingerprint(ids),
      q: filter.q ?? '',
      type: filter.type ?? '',
      category: '',
      repository: '',
      ...overrides,
    });
  }

  async function assigned(categoryId: string): Promise<number> {
    return (await listCategories(handle.db)).find((c) => c.id === categoryId)
      ?.artifactCount as number;
  }

  function expectRefreshed(): void {
    expect(next.revalidatePath).toHaveBeenCalledWith('/categories', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledWith('/artifacts', 'layout');
    expect(next.revalidatePath).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
  }

  it('assigns to and removes from the filtered list, carrying the category and refreshing', async () => {
    const alpha = await addArtifact('alpha');
    await addArtifact('beta');
    await addArtifact('gamma', 'rule');
    const clientA = await create('Client A');
    await assignArtifactCategory(handle, alpha, clientA);
    vi.clearAllMocks();
    expect(
      await setCategoryForListedArtifactsAction(
        idle,
        await bulk(clientA, 'assign', { type: 'skill' }),
      ),
    ).toEqual({
      kind: 'success',
      message: 'Assigned Client A to 1 artifact. 1 already had it.',
      categoryId: clientA,
    });
    expectRefreshed();
    expect(await assigned(clientA)).toBe(2);
    expect(
      await setCategoryForListedArtifactsAction(idle, await bulk(clientA, 'remove', { q: 'A' })),
    ).toEqual({
      kind: 'success',
      message: 'Removed Client A from 2 artifacts. 1 did not have it.',
      categoryId: clientA,
    });
    expectRefreshed();
    expect(await assigned(clientA)).toBe(0);
  });

  it('refuses forged fields, filters, fingerprint and mode, writing nothing and refreshing', async () => {
    await addArtifact('alpha');
    const clientA = await create('Client A');
    vi.clearAllMocks();
    const forged: Array<Record<string, string>> = [
      { mode: 'toggle' },
      { listFingerprint: 'not-a-fingerprint' },
      { type: 'script' },
      { category: '../etc' },
      { repository: 'repo with spaces' },
      { categoryId: '' },
    ];
    for (const overrides of forged) {
      expect(
        await setCategoryForListedArtifactsAction(
          idle,
          await bulk(clientA, 'assign', {}, overrides),
        ),
      ).toEqual({
        kind: 'error',
        message: INCOMPLETE_FORM_MESSAGE,
        categoryId: overrides.categoryId ?? clientA,
      });
      expectRefreshed();
    }
    // A well-formed fingerprint of another list: the list changed.
    expect(
      await setCategoryForListedArtifactsAction(
        idle,
        await bulk(clientA, 'assign', {}, { listFingerprint: idListFingerprint(['art_forged']) }),
      ),
    ).toEqual({
      kind: 'error',
      message: 'The list changed since the page loaded (now 1 artifact). Check it and try again.',
      categoryId: clientA,
    });
    expectRefreshed();
    // A forged category id names no category.
    expect(
      await setCategoryForListedArtifactsAction(idle, await bulk('cat_forged', 'remove')),
    ).toEqual({ kind: 'error', message: CATEGORY_GONE_MESSAGE, categoryId: 'cat_forged' });
    expectRefreshed();
    expect(await assigned(clientA)).toBe(0);
  });

  it('refuses an archived category in both modes', async () => {
    const alpha = await addArtifact('alpha');
    const python = await create('Python');
    await assignArtifactCategory(handle, alpha, python);
    await setCategoryArchivedAction(categoryIdle, form({ id: python, intent: 'archive' }));
    vi.clearAllMocks();
    expect(await setCategoryForListedArtifactsAction(idle, await bulk(python, 'remove'))).toEqual({
      kind: 'error',
      message: 'Python is archived. Unarchive it on its page before removing it from a list.',
      categoryId: python,
    });
    expectRefreshed();
    expect(await setCategoryForListedArtifactsAction(idle, await bulk(python, 'assign'))).toEqual({
      kind: 'error',
      message: 'Python is archived. Unarchive it on its page before assigning it.',
      categoryId: python,
    });
    expect(await assigned(python)).toBe(1);
  });
});
