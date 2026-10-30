import { fileURLToPath } from 'node:url';
import { MAX_REPOSITORY_PATH_LENGTH } from '@directivebench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDefinitionFile } from '@directivebench/benchmark-engine/load';
import {
  acquireNextJob,
  createBenchmarkRun,
  finishBenchmarkRun,
  getBlindReviewForReviewer,
  insertAgentRun,
  getJob,
  getRepositoryRegistration,
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
  assignArtifactSuiteAction,
  cancelJobAction,
  recordBlindVerdictAction,
  revealBlindReviewAction,
  startBlindReviewAction,
  enqueueBenchmarkRunAction,
  registerRepositoryAction,
  removeArtifactTagAction,
  saveArtifactNotesAction,
  scanRepositoryAction,
  unassignArtifactSuiteAction,
} from '../lib/actions';
import {
  ARTIFACT_GONE_MESSAGE,
  INCOMPLETE_FORM_MESSAGE,
  SUITE_GONE_MESSAGE,
  metadataLimits,
  type MetadataFormState,
} from '../lib/artifact-metadata';
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
