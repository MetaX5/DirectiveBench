import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRANCH_NAME_MESSAGE } from '@directivebench/core';
import {
  acquireNextJob,
  enqueueRepositoryBranchJob,
  enqueueRepositoryScanJob,
  finishJob,
  getRepository,
  getRepositoryBranchChange,
  migrateDatabase,
  openDatabase,
  registerLocalRepository,
  requestJobCancellation,
  schema,
  type DatabaseHandle,
  type RepositoryBranchPayload,
  type RepositoryRecord,
} from '@directivebench/database';
import {
  GitCancelledError,
  LocalRunner,
  NOT_FOUND_OR_NOT_PUBLIC,
  changeHostedBranch,
  hostedScanConfigHash,
  registerHostedUrl,
  scanHostedRepository,
  type HostedGitTransport,
  type HostedRepositoryOptions,
} from '../src/index';
import { FixtureRemote, fileTransport, git } from './support/hosted-fixtures';

// Issue 58 (SPEC-104 FR-104-07, FR-104-10, FR-104-14; SPEC-105 FR-105-05, FR-105-10, §14): the
// branch of a hosted repository, chosen at registration or changed later, checked against the
// remote with one ls-remote, and read by the next scan as a new snapshot. Real git against local
// bare repositories over file://, with a logging git on PATH; no network.

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');
/** Real git over several commits and scans (see hosted-repository.test.ts, issue #232). */
const realGit = { timeout: 30_000 };
const VERSION = '1.0.0';
const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}.\n---\n# ${name}\n`;

let handle: DatabaseHandle;
let dataDir: string;
let remotes: string;
let gitBin: string;
let gitLog: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-branch-data-'));
  remotes = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-branch-remotes-')));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  // A git on PATH that logs every call and runs the real git.
  const realGitPath = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  gitBin = join(remotes, '.logging-git');
  gitLog = join(remotes, 'git-calls.log');
  mkdirSync(gitBin);
  writeFileSync(
    join(gitBin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGitPath}' "$@"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
});

const cacheDir = () => join(dataDir, 'cache');
const cacheOf = (repositoryId: string) => join(cacheDir(), 'repos', `${repositoryId}.git`);

function options(overrides: Partial<HostedRepositoryOptions> = {}): HostedRepositoryOptions {
  return {
    env: { PATH: `${gitBin}${delimiter}${process.env.PATH}` },
    signal: new AbortController().signal,
    cacheDir: cacheDir(),
    transport: fileTransport(remotes),
    cacheSizePollIntervalMs: 5,
    appVersion: VERSION,
    ...overrides,
  };
}

/** The git calls since the last call, without the `-c` pairs before them. */
function gitCalls(): string[][] {
  if (!existsSync(gitLog)) return [];
  const lines = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean);
  rmSync(gitLog);
  return lines.map((line) => {
    const args = line.split(' ');
    let i = 0;
    while (args[i] === '-c') i += 2;
    return args.slice(i);
  });
}
const commands = () => gitCalls().map(([command]) => String(command));

/** A transport that runs `hook` once, when git is next given the remote URL after arming. */
function hooked(hook: () => void): { arm: () => void; transport: HostedGitTransport } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    transport: {
      protocol: 'file',
      remoteUrl: (location) => {
        if (armed) {
          armed = false;
          hook();
        }
        return fileTransport(remotes).remoteUrl(location);
      },
    },
  };
}

/** `acme/team-rules`: `main` with two rules, `release/2.0` with one of them changed and a new one. */
function teamRules(): FixtureRemote {
  const remote = new FixtureRemote(remotes, 'acme', 'team-rules', {
    '.agents/skills/review/SKILL.md': SKILL('review'),
    '.agents/skills/legacy/SKILL.md': SKILL('legacy'),
  });
  remote.branch('release/2.0', {
    '.agents/skills/review/SKILL.md': SKILL('review-2'),
    '.agents/skills/legacy/SKILL.md': '',
    '.agents/skills/release/SKILL.md': SKILL('release'),
  });
  // An empty file is not a skill: `legacy` exists only on main.
  git(remote.work, ['checkout', '-q', 'release/2.0']);
  git(remote.work, ['rm', '-q', '.agents/skills/legacy/SKILL.md']);
  git(remote.work, ['commit', '-q', '-m', 'drop legacy']);
  git(remote.work, ['push', '-q', 'origin', 'HEAD:refs/heads/release/2.0']);
  git(remote.work, ['checkout', '-q', 'main']);
  return remote;
}

async function register(location: string, branch: string | null = null) {
  const result = await registerHostedUrl(handle, { url: location, branch }, options());
  if (!result.ok) throw new Error(result.message);
  return (await getRepository(handle.db, result.repositoryId)) as RepositoryRecord;
}

/** Runs a branch change the way the runner does: a claimed job, then the change. */
async function change(
  repository: Pick<RepositoryRecord, 'id'>,
  branch: string | null,
  overrides: Partial<HostedRepositoryOptions> = {},
) {
  const outcome = await enqueueRepositoryBranchJob(handle, { repositoryId: repository.id, branch });
  if (outcome.status !== 'enqueued') throw new Error(outcome.status);
  await acquireNextJob(handle.db, 'runner', { types: ['repository-branch'] });
  const payload: RepositoryBranchPayload = { repositoryId: repository.id, branch };
  const result = await changeHostedBranch(
    handle,
    { jobId: outcome.job.id, payload },
    options(overrides),
  );
  await finishJob(handle.db, outcome.job.id, 'completed', undefined, result);
  return result;
}

/** A scan as the runner runs it, on the repository's current row. */
async function scan(repositoryId: string, overrides: Partial<HostedRepositoryOptions> = {}) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  await acquireNextJob(handle.db, 'runner', { types: ['repository-scan'] });
  const current = (await getRepository(handle.db, repositoryId)) as RepositoryRecord;
  const result = await scanHostedRepository(
    handle,
    { jobId: job.id, repository: current },
    options(overrides),
  );
  if (result.ok) await finishJob(handle.db, job.id, 'completed', undefined, result);
  else await finishJob(handle.db, job.id, 'failed', result.message, result);
  return result;
}

const occurrences = (repositoryId: string) =>
  Object.fromEntries(
    handle.sqlite
      .prepare(
        'select path, status from artifact_occurrences where repository_id = ? order by path',
      )
      .all(repositoryId)
      .map((row) => [String(row.path), String(row.status)]),
  );
const cacheRefs = (repositoryId: string) =>
  git(cacheOf(repositoryId), ['for-each-ref', '--format=%(refname)']).trim().split('\n');

describe('registration with a branch (issue 58)', realGit, () => {
  posixOnly(
    'checks the branch with one ls-remote and stores it, null for the default',
    async () => {
      const remote = teamRules();
      const repository = await register(remote.location, 'release/2.0');
      expect(repository).toMatchObject({ selectedBranch: 'release/2.0', defaultBranch: 'main' });
      const calls = gitCalls();
      expect(calls.map(([command]) => command)).toEqual(['version', 'ls-remote']);
      expect(calls[1]?.slice(-3)).toEqual([
        fileTransport(remotes).remoteUrl(remote.location),
        'HEAD',
        'refs/heads/release/2.0',
      ]);

      const other = new FixtureRemote(remotes, 'acme', 'other', { 'AGENTS.md': '# Rules\n' });
      expect(await register(other.location, 'main')).toMatchObject({
        selectedBranch: null,
        defaultBranch: 'main',
      });
    },
  );

  posixOnly('stores nothing for a branch the remote does not have, or an unsafe name', async () => {
    const remote = teamRules();
    // ls-remote matches the tail of a ref: `2.0` is no branch even though `release/2.0` ends so.
    for (const branch of ['relase', '2.0']) {
      expect(await registerHostedUrl(handle, { url: remote.location, branch }, options())).toEqual({
        ok: false,
        code: 'branch-not-found',
        message: `The branch ${branch} does not exist in acme/team-rules. Check the name on GitHub, or leave Branch empty to use the default branch.`,
      });
    }
    gitCalls();
    expect(
      await registerHostedUrl(handle, { url: remote.location, branch: '-x' }, options()),
    ).toEqual({ ok: false, code: 'branch-not-found', message: BRANCH_NAME_MESSAGE });
    expect(gitCalls()).toEqual([]);
    expect(await handle.db.$count(schema.repositories)).toBe(0);
  });

  posixOnly('never changes the branch of a repository registered again', async () => {
    const remote = teamRules();
    const first = await register(remote.location, 'release/2.0');
    const result = await registerHostedUrl(
      handle,
      { url: remote.location, branch: null },
      options(),
    );
    expect(result).toEqual({ ok: true, repositoryId: first.id, created: false });
    expect(await getRepository(handle.db, first.id)).toMatchObject({
      selectedBranch: 'release/2.0',
    });
  });
});

describe('the repository-branch job (issue 58)', realGit, () => {
  posixOnly(
    'checks and stores a branch, the default as null, and empty as the default',
    async () => {
      const remote = teamRules();
      const repository = await register(remote.location);
      gitCalls();
      expect(await change(repository, 'release/2.0')).toEqual({
        ok: true,
        branch: 'release/2.0',
        defaultBranch: 'main',
      });
      expect(commands()).toEqual(['version', 'ls-remote']);
      expect(await getRepository(handle.db, repository.id)).toMatchObject({
        selectedBranch: 'release/2.0',
      });
      expect(await change(repository, 'main')).toEqual({
        ok: true,
        branch: null,
        defaultBranch: 'main',
      });
      await change(repository, 'release/2.0');
      expect(await change(repository, null)).toEqual({
        ok: true,
        branch: null,
        defaultBranch: 'main',
      });
      // Saving never scans or downloads.
      expect(existsSync(cacheOf(repository.id))).toBe(false);
    },
  );

  posixOnly('changes nothing for a branch the remote does not have', async () => {
    const remote = teamRules();
    const repository = await register(remote.location, 'release/2.0');
    expect(await change(repository, 'release/3.0')).toEqual({
      ok: false,
      code: 'branch-not-found',
      message:
        'The branch release/3.0 does not exist in acme/team-rules. Nothing was changed: the repository still uses release/2.0.',
    });
    await change(repository, null);
    expect(await change(repository, 'nope')).toMatchObject({
      message: expect.stringMatching(/the repository still uses main\.$/),
    });
    // A repository that never reported a default branch.
    handle.sqlite
      .prepare('update repositories set default_branch = null where id = ?')
      .run(repository.id);
    const empty = new FixtureRemote(remotes, 'acme', 'empty');
    handle.sqlite
      .prepare("update repositories set location = 'https://github.com/acme/empty' where id = ?")
      .run(repository.id);
    expect(empty.location).toBe('https://github.com/acme/empty');
    expect(await change(repository, 'dev')).toMatchObject({
      message: expect.stringMatching(/the repository still uses its default branch\.$/),
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ selectedBranch: null });
  });

  posixOnly('reports the remote and git failures of the check and stores nothing', async () => {
    const remote = teamRules();
    const repository = await register(remote.location);
    rmSync(remote.bare, { recursive: true, force: true });
    expect(await change(repository, 'release/2.0')).toEqual({
      ok: false,
      code: 'auth-required',
      message: NOT_FOUND_OR_NOT_PUBLIC,
    });
    expect(await change(repository, 'release/2.0', { env: {} })).toEqual({
      ok: false,
      code: 'git-not-installed',
      message: 'git was not found on PATH.',
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ selectedBranch: null });
  });

  posixOnly('refuses a missing, local or malformed repository before any git call', async () => {
    gitCalls();
    expect(
      await changeHostedBranch(
        handle,
        { jobId: 'job_x', payload: { repositoryId: 'repo_missing', branch: null } },
        options(),
      ),
    ).toEqual({
      ok: false,
      code: 'repository-not-found',
      message: 'That repository is no longer registered. Nothing was changed.',
    });
    const local = await registerLocalRepository(
      handle,
      { provider: 'local-directory', name: 'local', location: '/srv/local', defaultBranch: null },
      { homeDirectory: '/home/tester', confirmedLocation: null, userLevel: null },
    );
    if (local.status !== 'registered') throw new Error(local.status);
    expect(
      await changeHostedBranch(
        handle,
        { jobId: 'job_x', payload: { repositoryId: local.repository.id, branch: 'main' } },
        options(),
      ),
    ).toMatchObject({ ok: false, code: 'unsupported-provider' });

    const remote = teamRules();
    const repository = await register(remote.location);
    gitCalls();
    for (const location of ['https://github.com/acme/Team-Rules', 'https://evil.example/acme/x']) {
      handle.sqlite
        .prepare('update repositories set location = ? where id = ?')
        .run(location, repository.id);
      expect(
        await changeHostedBranch(
          handle,
          { jobId: 'job_x', payload: { repositoryId: repository.id, branch: 'main' } },
          options(),
        ),
      ).toEqual({
        ok: false,
        code: 'invalid-url',
        message: 'The stored repository location is invalid.',
      });
    }
    expect(gitCalls()).toEqual([]);
  });

  posixOnly(
    'writes nothing when the job is cancelled, a scan starts or the repository is removed meanwhile',
    async () => {
      const remote = teamRules();
      const repository = await register(remote.location);
      let jobId = '';
      const cancel = hooked(() => {
        handle.sqlite.prepare("update jobs set cancel_requested_at = 't' where id = ?").run(jobId);
      });
      const outcome = await enqueueRepositoryBranchJob(handle, {
        repositoryId: repository.id,
        branch: 'release/2.0',
      });
      if (outcome.status !== 'enqueued') throw new Error(outcome.status);
      jobId = outcome.job.id;
      await acquireNextJob(handle.db, 'runner', { types: ['repository-branch'] });
      cancel.arm();
      await expect(
        changeHostedBranch(
          handle,
          { jobId, payload: { repositoryId: repository.id, branch: 'release/2.0' } },
          options({ transport: cancel.transport }),
        ),
      ).rejects.toBeInstanceOf(GitCancelledError);
      await requestJobCancellation(handle.db, jobId);
      await finishJob(handle.db, jobId, 'cancelled');
      expect(await getRepository(handle.db, repository.id)).toMatchObject({ selectedBranch: null });

      const scanning = hooked(() => {
        handle.sqlite
          .prepare(
            `insert into jobs (id, type, status, payload, created_at) values ('job_scan', 'repository-scan', 'pending', ?, 't')`,
          )
          .run(JSON.stringify({ repositoryId: repository.id }));
      });
      scanning.arm();
      expect(await change(repository, 'release/2.0', { transport: scanning.transport })).toEqual({
        ok: false,
        code: 'scan-active',
        message:
          'A scan of this repository is waiting or running. Change its branch after the scan finishes.',
      });
      handle.sqlite.exec("update jobs set status = 'cancelled' where id = 'job_scan'");

      const removing = hooked(() => {
        handle.sqlite.prepare('delete from repositories where id = ?').run(repository.id);
      });
      removing.arm();
      expect(await change(repository, 'release/2.0', { transport: removing.transport })).toEqual({
        ok: false,
        code: 'repository-not-found',
        message: 'That repository was removed meanwhile. Nothing was changed.',
      });
    },
  );

  posixOnly('rethrows an unexpected error of the write', async () => {
    const remote = teamRules();
    const repository = await register(remote.location);
    handle.sqlite.exec(
      "CREATE TRIGGER fail_branch BEFORE UPDATE OF selected_branch ON repositories BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
    );
    await expect(change(repository, 'release/2.0')).rejects.toThrow();
  });

  posixOnly('runs as a short job of the runner and records its outcome', async () => {
    const remote = teamRules();
    const repository = await register(remote.location);
    const runner = new LocalRunner({
      handle,
      fixtureStore: join(dataDir, 'fixtures'),
      cacheDir: cacheDir(),
      adapters: new Map(),
      workspaceRoot: join(dataDir, 'workspaces'),
      hostedGitTransport: fileTransport(remotes),
      hostedGitLimits: { cacheSizePollIntervalMs: 5 },
    });
    const outcome = await enqueueRepositoryBranchJob(handle, {
      repositoryId: repository.id,
      branch: 'release/2.0',
    });
    if (outcome.status !== 'enqueued') throw new Error(outcome.status);
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    expect(await getRepositoryBranchChange(handle.db, outcome.job.id)).toMatchObject({
      status: 'completed',
      result: { ok: true, branch: 'release/2.0', defaultBranch: 'main' },
    });

    // Codex review round 2 of PR #248: the job's completion write fails after the branch
    // committed. The job fails with the fixed message, which never claims nothing changed.
    handle.sqlite.exec(
      `CREATE TRIGGER fail_branch_completion BEFORE UPDATE OF status ON jobs
         WHEN old.type = 'repository-branch' AND new.status = 'completed'
         BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const failing = await enqueueRepositoryBranchJob(handle, {
      repositoryId: repository.id,
      branch: null,
    });
    if (failing.status !== 'enqueued') throw new Error(failing.status);
    const [finished] = await runner.runUntilIdle();
    expect(finished).toMatchObject({ status: 'failed' });
    expect(finished?.error).toMatch(
      /^The branch change failed unexpectedly\. The new branch may have been saved/,
    );
    expect(finished?.error).not.toContain('Nothing was changed');
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ selectedBranch: null });
    handle.sqlite.exec('DROP TRIGGER fail_branch_completion');

    // A stored payload that does not parse fails the job with the reason.
    handle.sqlite
      .prepare(
        `insert into jobs (id, type, status, payload, created_at) values ('job_bad', 'repository-branch', 'pending', ?, 't')`,
      )
      .run(JSON.stringify({ repositoryId: repository.id, branch: '-x' }));
    expect(await runner.runUntilIdle()).toMatchObject([
      {
        status: 'failed',
        error: `The stored branch change is invalid: ${BRANCH_NAME_MESSAGE}`,
      },
    ]);
  });
});

describe('scanning after a branch change (issue 58)', realGit, () => {
  posixOnly(
    'reads the new branch into a fresh cache, records it and marks old-only paths missing',
    async () => {
      const remote = teamRules();
      const repository = await register(remote.location);
      const first = await scan(repository.id);
      expect(first).toMatchObject({ ok: true, branch: 'main', createdArtifacts: 2 });
      expect(await getRepository(handle.db, repository.id)).toMatchObject({
        scannedBranch: 'main',
      });
      expect(cacheRefs(repository.id)).toEqual(['refs/heads/main']);

      await change(repository, 'release/2.0');
      // Saving did not touch the scanned branch: the page says "That scan read main".
      expect(await getRepository(handle.db, repository.id)).toMatchObject({
        selectedBranch: 'release/2.0',
        scannedBranch: 'main',
      });
      gitCalls();
      const second = await scan(repository.id);
      expect(second).toMatchObject({
        ok: true,
        branch: 'release/2.0',
        commitSha: remote.head('release/2.0'),
        scanConfigHash: hostedScanConfigHash(VERSION, 'release/2.0'),
        createdArtifacts: 1,
        createdVersions: 2,
        removedOccurrences: 1,
      });
      const calls = commands();
      // The cache held main: it is listed, deleted and cloned again, never fetched into.
      expect(calls.slice(0, 3)).toEqual(['version', 'for-each-ref', 'clone']);
      expect(calls.slice(0, calls.indexOf('clone'))).not.toContain('fetch');
      expect(cacheRefs(repository.id)).toEqual(['refs/heads/release/2.0']);
      expect(git(cacheOf(repository.id), ['rev-list', '--all']).trim().split('\n')).toEqual([
        remote.head('release/2.0'),
      ]);
      expect(occurrences(repository.id)).toEqual({
        '.agents/skills/legacy': 'removed',
        '.agents/skills/release': 'active',
        '.agents/skills/review': 'active',
      });
      expect(await getRepository(handle.db, repository.id)).toMatchObject({
        scannedBranch: 'release/2.0',
        lastCommitSha: remote.head('release/2.0'),
      });

      // Switching back finds the old-only artifact again, with its history.
      await change(repository, null);
      expect(await scan(repository.id)).toMatchObject({
        ok: true,
        branch: 'main',
        reactivatedOccurrences: 1,
        removedOccurrences: 1,
      });
      expect(occurrences(repository.id)).toMatchObject({
        '.agents/skills/legacy': 'active',
        '.agents/skills/release': 'removed',
      });
    },
  );

  posixOnly(
    'reads a branch in full even when it points at the commit of the last scan',
    async () => {
      const remote = teamRules();
      remote.branch('mirror');
      const repository = await register(remote.location);
      expect(await scan(repository.id)).toMatchObject({ ok: true, branch: 'main' });
      expect(await scan(repository.id)).toMatchObject({ ok: true, unchanged: true });
      await change(repository, 'mirror');
      gitCalls();
      const result = await scan(repository.id);
      expect(result).toMatchObject({ ok: true, branch: 'mirror', commitSha: remote.head('main') });
      expect(result.ok && result.unchanged).toBeFalsy();
      expect(commands()).toContain('ls-tree');
    },
  );

  posixOnly(
    'applies nothing when the effective branch changes during a full or an unchanged scan',
    async () => {
      const remote = teamRules();
      const repository = await register(remote.location);
      expect(await scan(repository.id)).toMatchObject({ ok: true });
      const before = occurrences(repository.id);
      // A re-registration refreshes the default branch while the scan runs.
      const refresh = hooked(() => {
        handle.sqlite
          .prepare("update repositories set default_branch = 'release/2.0' where id = ?")
          .run(repository.id);
      });
      refresh.arm();
      // Unchanged remote: step 0 runs, then the write refuses.
      expect(await scan(repository.id, { transport: refresh.transport })).toEqual({
        ok: false,
        code: 'branch-changed',
        message: 'The branch changed during the scan. Scan again.',
      });
      expect(await getRepository(handle.db, repository.id)).toMatchObject({
        syncStatus: 'error',
        syncError: 'The branch changed during the scan. Scan again.',
        scannedBranch: 'main',
      });
      // A full scan (the failure broke the baseline) refuses the same way.
      handle.sqlite
        .prepare("update repositories set default_branch = 'main' where id = ?")
        .run(repository.id);
      remote.commit({ 'AGENTS.md': '# New\n' });
      // Without a cache the clone is the step that is given the remote URL.
      rmSync(cacheOf(repository.id), { recursive: true, force: true });
      refresh.arm();
      expect(await scan(repository.id, { transport: refresh.transport })).toMatchObject({
        ok: false,
        code: 'branch-changed',
      });
      expect(occurrences(repository.id)).toEqual(before);
    },
  );

  posixOnly('keeps the occurrences when the chosen branch was deleted upstream', async () => {
    const remote = teamRules();
    const repository = await register(remote.location, 'release/2.0');
    expect(await scan(repository.id)).toMatchObject({ ok: true, branch: 'release/2.0' });
    const before = occurrences(repository.id);
    remote.deleteBranch('release/2.0');
    const message =
      'The branch release/2.0 does not exist in the repository any more. Change the branch, or leave it empty to use the default branch.';
    expect(await scan(repository.id)).toEqual({ ok: false, code: 'branch-not-found', message });
    expect(occurrences(repository.id)).toEqual(before);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncError: message });
  });
});
