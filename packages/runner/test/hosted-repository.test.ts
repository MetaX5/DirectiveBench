import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverArtifacts } from '@directivebench/core';
import {
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  getRepository,
  getRepositoryRegistration,
  getRepositoryScan,
  migrateDatabase,
  openDatabase,
  registerHostedRepository,
  schema,
  type DatabaseHandle,
  type RepositoryRecord,
} from '@directivebench/database';
import {
  GitCancelledError,
  HTTPS_TRANSPORT,
  LocalRunner,
  NOT_FOUND_OR_NOT_PUBLIC,
  registerHostedUrl,
  scanHostedRepository,
  type HostedRepositoryOptions,
} from '../src/index';
import {
  FIXTURE_GIT_ENV,
  FixtureRemote,
  fakeGit,
  fileTransport,
  git,
  objectsIn,
  writeFiles,
} from './support/hosted-fixtures';
import { buildHostedGitEnv, hostedGitArgs } from '../src/hosted-git';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');

const SKILL = '---\nname: review\ndescription: Review pull requests.\n---\n# Review\n';

let handle: DatabaseHandle;
let dataDir: string;
let remotes: string;
let marker: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-hosted-data-'));
  remotes = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-hosted-remotes-')));
  marker = join(remotes, 'executed.marker');
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
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
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    cacheDir: cacheDir(),
    transport: fileTransport(remotes),
    cacheSizePollIntervalMs: 5,
    ...overrides,
  };
}

const touch = `#!/bin/sh\ntouch "${'MARKER'}"\n`;

/** A repository with every kind of entry a scan must handle, plus hostile content. */
function teamSkills(): FixtureRemote {
  return new FixtureRemote(remotes, 'acme', 'team-skills', {
    '.agents/skills/review/SKILL.md': SKILL,
    '.agents/skills/review/references/checklist.md': '# Checklist\n',
    '.agents/skills/review/scripts/run.sh': touch.replace('MARKER', marker),
    'AGENTS.md': '# Repository rules\n',
    '.cursor/rules/react.mdc': '---\nglobs: "src/**/*.tsx"\n---\n# React\n',
    '.github/copilot-instructions.md': '# Copilot\n',
    'README.md': '# Not an artifact\n',
    'assets/large.bin': Buffer.alloc(300 * 1024, 7),
    'node_modules/pkg/SKILL.md': '---\nname: hidden\n---\n',
    '.gitattributes': '*.md filter=evil\n',
  });
}

async function registered(remote: FixtureRemote): Promise<RepositoryRecord> {
  const result = await registerHostedUrl(handle, remote.location, options());
  if (!result.ok) throw new Error(result.message);
  return (await getRepository(handle.db, result.repositoryId)) as RepositoryRecord;
}

/** Runs a scan the way the runner does: a running job, then the hosted scan. */
async function scan(
  repository: RepositoryRecord,
  overrides: Partial<HostedRepositoryOptions> = {},
) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
  handle.sqlite.prepare(`update jobs set status = 'running' where id = ?`).run(job.id);
  const current = (await getRepository(handle.db, repository.id)) as RepositoryRecord;
  return scanHostedRepository(handle, { jobId: job.id, repository: current }, options(overrides));
}

describe('registerHostedUrl', () => {
  it('registers a public repository with provider github and its default branch, without credentials', async () => {
    const remote = teamSkills();
    git(remote.bare, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    git(remote.bare, ['update-ref', 'refs/heads/trunk', remote.head()]);
    const result = await registerHostedUrl(
      handle,
      'https://github.com/Acme/Team-Skills.git',
      options(),
    );
    expect(result).toMatchObject({ ok: true, created: true });
    const [repository] = await handle.db.select().from(schema.repositories);
    expect(repository).toMatchObject({
      provider: 'github',
      name: 'Acme/Team-Skills',
      location: 'https://github.com/acme/team-skills',
      defaultBranch: 'trunk',
      syncStatus: 'never',
    });
    // Registration downloads nothing: no cache exists yet, only the private layout.
    expect(readdirSync(join(cacheDir(), 'repos'))).toEqual([]);
    for (const dir of [cacheDir(), join(cacheDir(), 'repos'), join(cacheDir(), 'git-home')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(cacheDir(), 'git-home'))).toEqual([]);
    // The same repository again returns the existing row.
    expect(await registerHostedUrl(handle, remote.location, options())).toEqual({
      ok: true,
      repositoryId: repository?.id,
      created: false,
    });
  });

  it('stores no default branch for an empty repository, and detects it on a new registration', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'empty');
    expect(await registerHostedUrl(handle, remote.location, options())).toMatchObject({ ok: true });
    const [empty] = await handle.db.select().from(schema.repositories);
    expect(empty?.defaultBranch).toBeNull();
    expect(await scan(empty as RepositoryRecord)).toMatchObject({ code: 'branch-not-found' });
    // Regression (review of PR #51): registering the URL again is the way out the error names.
    remote.commit({ 'AGENTS.md': '# Rules\n' });
    expect(await registerHostedUrl(handle, remote.location, options())).toMatchObject({
      ok: true,
      created: false,
    });
    const repository = (await getRepository(handle.db, String(empty?.id))) as RepositoryRecord;
    expect(repository.defaultBranch).toBe('main');
    expect(await scan(repository)).toMatchObject({ ok: true, discovered: 1 });
  });

  it('rejects a missing repository as not found or not public and stores nothing', async () => {
    const result = await registerHostedUrl(handle, 'https://github.com/acme/missing', options());
    expect(result).toEqual({ ok: false, code: 'auth-required', message: NOT_FOUND_OR_NOT_PUBLIC });
    expect(await handle.db.$count(schema.repositories)).toBe(0);
  });

  it('rejects an invalid URL without running git', async () => {
    const result = await registerHostedUrl(handle, 'https://user:pw@github.com/a/b', options());
    expect(result).toMatchObject({ ok: false, code: 'invalid-url' });
    expect(existsSync(cacheDir())).toBe(false);
  });

  it('reports a missing git', async () => {
    const result = await registerHostedUrl(handle, 'https://github.com/a/b', options({ env: {} }));
    expect(result).toEqual({
      ok: false,
      code: 'git-not-installed',
      message: 'git was not found on PATH.',
    });
  });

  posixOnly('refuses a git older than 2.44, which cannot disable implicit downloads', async () => {
    const bin = join(remotes, 'old-git');
    fakeGit(bin, { version: { stdout: 'git version 2.43.0\n' } });
    const result = await registerHostedUrl(
      handle,
      'https://github.com/a/b',
      options({ env: { PATH: bin } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'git-too-old' });
    expect(result.ok ? '' : result.message).toContain('git version 2.43.0');
  });

  it('never reaches the network in production mode for a refused protocol', async () => {
    // The production transport allows only https; a file:// remote is refused by git itself.
    const remote = teamSkills();
    const result = await registerHostedUrl(
      handle,
      remote.location,
      options({ transport: { remoteUrl: fileTransport(remotes).remoteUrl, protocol: 'https' } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'git-failed' });
    expect(result.ok ? '' : result.message).toMatch(/transport 'file' not allowed/);
    expect(HTTPS_TRANSPORT.remoteUrl(remote.location)).toBe(remote.location);
  });

  it('stops git when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(
      registerHostedUrl(handle, 'https://github.com/a/b', options({ signal: controller.signal })),
    ).rejects.toThrow(GitCancelledError);
  });
});

describe('scanHostedRepository', () => {
  it('discovers artifacts like a local scan, records the commit and downloads only candidate blobs', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    const result = await scan(repository);
    const commit = remote.head();
    expect(result).toMatchObject({
      ok: true,
      discovered: 4,
      createdArtifacts: 4,
      createdVersions: 4,
      errorCount: 0,
      commitSha: commit,
    });

    // Same rules as E01-S02: the artifacts equal a walk of the same tree on disk.
    const local = await discoverArtifacts(remote.work);
    const versions = await handle.db.select().from(schema.artifactVersions);
    expect(versions.map((v) => v.sourcePath).sort()).toEqual(
      local.artifacts.map((a) => a.occurrencePath).sort(),
    );
    expect(versions.map((v) => v.contentHash).sort()).toEqual(
      local.artifacts.map((a) => a.contentHash).sort(),
    );
    expect(new Set(versions.map((v) => v.sourceCommitSha))).toEqual(new Set([commit]));
    const occurrences = await handle.db.select().from(schema.artifactOccurrences);
    expect(occurrences.map((o) => o.commitSha)).toEqual(Array(4).fill(commit));
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      lastCommitSha: commit,
      syncStatus: 'ok',
      syncError: null,
    });

    // The cache: bare, private, and holding exactly the candidate blobs.
    const cache = cacheOf(repository.id);
    expect(statSync(cache).mode & 0o777).toBe(0o700);
    expect(readdirSync(cache).sort()).toEqual([
      'HEAD',
      'config',
      'objects',
      'packed-refs',
      'refs',
      'shallow',
    ]);
    const blobs = objectsIn(cache)
      .filter((object) => object.type === 'blob')
      .map((o) => o.oid);
    const candidates = [
      '.agents/skills/review/SKILL.md',
      '.agents/skills/review/references/checklist.md',
      '.agents/skills/review/scripts/run.sh',
      'AGENTS.md',
      '.cursor/rules/react.mdc',
      '.github/copilot-instructions.md',
    ].map((path) => remote.blob(path));
    expect(blobs.sort()).toEqual([...new Set(candidates)].sort());
    for (const path of [
      'README.md',
      'assets/large.bin',
      'node_modules/pkg/SKILL.md',
      '.gitattributes',
    ]) {
      expect(blobs).not.toContain(remote.blob(path));
    }
    // Nothing ran: no hook, filter or script, and no checkout.
    expect(existsSync(marker)).toBe(false);
  });

  it('fetches into the existing cache on a rescan, downloading only the changed candidate blob', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true, createdVersions: 4 });
    const cache = cacheOf(repository.id);
    const before = objectsIn(cache).filter((o) => o.type === 'blob').length;
    const commit = remote.commit({
      'AGENTS.md': '# Repository rules, edited\n',
      'README.md': '# Edited\n',
    });
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdVersions: 1,
      commitSha: commit,
    });
    const blobs = objectsIn(cache)
      .filter((o) => o.type === 'blob')
      .map((o) => o.oid);
    expect(blobs).toHaveLength(before + 1);
    expect(blobs).toContain(remote.blob('AGENTS.md'));
    expect(blobs).not.toContain(remote.blob('README.md'));
    // The same commit again: no new versions (NFR-105-04).
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdVersions: 0,
      commitSha: commit,
    });
  });

  it('replaces a broken cache with a fresh clone', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    mkdirSync(cacheOf(repository.id), { recursive: true });
    writeFileSync(join(cacheOf(repository.id), 'garbage'), 'not a repository');
    expect(await scan(repository)).toMatchObject({ ok: true, discovered: 4 });
    expect(existsSync(join(cacheOf(repository.id), 'garbage'))).toBe(false);
  });

  it('ignores the user-level git configuration, credential helpers and URL rewrites', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    const home = join(remotes, 'home');
    const hostile = [
      '[core]',
      `\thooksPath = ${join(remotes, 'hooks')}`,
      '[credential]',
      `\thelper = !touch ${marker}`,
      '[filter "evil"]',
      `\tsmudge = touch ${marker}`,
      `[url "file:///nonexistent/"]`,
      `\tinsteadOf = ${fileTransport(remotes)
        .remoteUrl(remote.location)
        .replace(/acme.*$/, '')}`,
      '',
    ].join('\n');
    writeFiles(home, { '.gitconfig': hostile, '.config/git/config': hostile });
    writeFiles(join(remotes, 'hooks'), { 'post-checkout': touch.replace('MARKER', marker) });
    const result = await scan(repository, {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_CONFIG_PARAMETERS: `'credential.helper'='!touch ${marker}'`,
        GIT_ASKPASS: `/bin/sh -c 'touch ${marker}'`,
        GIT_SSL_NO_VERIFY: '1',
      },
    });
    expect(result).toMatchObject({ ok: true, discovered: 4 });
    expect(existsSync(marker)).toBe(false);
  });

  it('reads no configuration of a git repository that encloses the data directory', async () => {
    const remote = teamSkills();
    // Where the hostile configuration points instead: another repository with another branch.
    const evil = new FixtureRemote(remotes, 'evil', 'team-skills', {
      'AGENTS.md': '# Evil rules\n',
      '.agents/skills/evil/SKILL.md': SKILL.replaceAll('review', 'evil'),
    });
    git(evil.bare, ['update-ref', 'refs/heads/evil', evil.head()]);
    git(evil.bare, ['symbolic-ref', 'HEAD', 'refs/heads/evil']);
    const acmeBase = fileTransport(remotes)
      .remoteUrl(remote.location)
      .replace(/team-skills\.git$/, '');
    const evilBase = acmeBase.replace(/acme\/$/, 'evil/');
    const outer = join(remotes, 'outer');
    mkdirSync(outer);
    git(outer, ['init', '-q']);
    writeFiles(outer, { 'rewrite.gitconfig': `[url "${evilBase}"]\n\tinsteadOf = ${acmeBase}\n` });
    for (const [key, value] of [
      ['include.path', join(outer, 'rewrite.gitconfig')],
      ['http.extraHeader', 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      ['http.sslVerify', 'false'],
      ['http.proxy', 'http://127.0.0.1:9'],
      ['credential.helper', `!touch ${marker}`],
      ['remote.origin.url', evil.bare],
      ['remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
    ] as const) {
      git(outer, ['config', key, value]);
    }
    const cache = join(outer, 'data', 'cache');
    mkdirSync(cache, { recursive: true });
    // Armed: plain git anywhere below the data directory loads all of it, the include too.
    const plain = git(cache, ['config', '--show-origin', '--list']);
    expect(plain).toContain(`insteadof=${acmeBase}`);
    expect(plain).toContain('http.sslverify=false');
    expect(plain).toContain('http.extraheader=Authorization');

    // Registration (ls-remote) detects the real repository's default branch, not evil's.
    const registration = await registerHostedUrl(
      handle,
      remote.location,
      options({ cacheDir: cache }),
    );
    if (!registration.ok) throw new Error(registration.message);
    const repository = (await getRepository(
      handle.db,
      registration.repositoryId,
    )) as RepositoryRecord;
    expect(repository.defaultBranch).toBe('main');

    // Clone, listing, blob fetch and reads use the real repository.
    expect(await scan(repository, { cacheDir: cache })).toMatchObject({
      ok: true,
      discovered: 4,
      commitSha: remote.head(),
    });
    // Fetch into the existing cache.
    const commit = remote.commit({ 'AGENTS.md': '# Repository rules, edited\n' });
    expect(await scan(repository, { cacheDir: cache })).toMatchObject({
      ok: true,
      createdVersions: 1,
      commitSha: commit,
    });
    // A broken cache is not a repository: git must not walk up to the enclosing one.
    const cacheRepo = join(cache, 'repos', `${repository.id}.git`);
    rmSync(join(cacheRepo, 'HEAD'));
    expect(await scan(repository, { cacheDir: cache })).toMatchObject({
      ok: true,
      commitSha: commit,
    });
    const versions = await handle.db.select().from(schema.artifactVersions);
    expect(versions.map((v) => v.sourcePath).filter((path) => path?.includes('evil'))).toEqual([]);
    expect(git(outer, ['for-each-ref'])).toBe('');
    expect(existsSync(marker)).toBe(false);

    // What each kind of hosted invocation sees: the command line, and the cache's own config.
    const home = join(cache, 'git-home');
    for (const [cwd, gitDir, origins] of [
      [home, null, ['command line:']],
      [cacheRepo, cacheRepo, ['command line:', `file:${cacheRepo}/config`]],
    ] as const) {
      const { env } = buildHostedGitEnv({ PATH: process.env.PATH }, home, 'local', gitDir);
      const listing = execFileSync(
        'git',
        hostedGitArgs('file', ['config', '--show-origin', '--list']),
        { cwd, env },
      ).toString();
      const seen = new Set(
        listing
          .trim()
          .split('\n')
          .map((line) => line.split('\t')[0]),
      );
      expect([...seen].sort()).toEqual([...origins].sort());
    }
  });

  it('reports symlinks at candidate paths, skips submodules and never fetches either', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'links', { 'AGENTS.md': '# Rules\n' });
    execFileSync('ln', ['-s', '/etc/passwd', 'CLAUDE.md'], { cwd: remote.work });
    remote.commit({});
    // A submodule (gitlink) at a candidate path: a commit object, never a file to read.
    git(remote.work, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${remote.head()},vendor/AGENTS.md`,
    ]);
    git(remote.work, ['commit', '-q', '-m', 'submodule']);
    git(remote.work, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    expect(git(remote.bare, ['ls-tree', '-r', 'main'])).toContain('160000 commit');
    const repository = await registered(remote);
    const result = await scan(repository);
    expect(result).toMatchObject({ ok: true, discovered: 1, errorCount: 1 });
    expect(result.ok ? result.errors : []).toEqual([
      {
        path: 'CLAUDE.md',
        code: 'symlink',
        message: 'CLAUDE.md is a symbolic link and is not followed',
      },
    ]);
    const blobs = objectsIn(cacheOf(repository.id)).filter((o) => o.type === 'blob');
    expect(blobs.map((o) => o.oid)).toEqual([remote.blob('AGENTS.md')]);
  });

  it('scans a repository without artifacts without fetching any blob', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'plain', { 'README.md': '# Nothing here\n' });
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true, scannedFiles: 1, discovered: 0 });
    expect(objectsIn(cacheOf(repository.id)).filter((o) => o.type === 'blob')).toEqual([]);
  });

  it('applies the per-file limits to blobs, loading none above the largest one', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'large', {
      'AGENTS.md': `# ${'x'.repeat(1024 * 1024)}\n`,
      'big/SKILL.md': SKILL,
      'big/huge.md': 'y'.repeat(6 * 1024 * 1024),
    });
    const repository = await registered(remote);
    const result = await scan(repository);
    expect(result.ok ? result.errors.map((e) => [e.path, e.code]) : []).toEqual([
      ['AGENTS.md', 'too-large'],
      ['big/SKILL.md', 'too-large'],
    ]);
  });

  it('fails a branch that no longer exists and deletes the cache', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    handle.sqlite
      .prepare(`update repositories set default_branch = 'gone' where id = ?`)
      .run(repository.id);
    expect(await scan(repository)).toEqual({
      ok: false,
      code: 'branch-not-found',
      message:
        'The branch gone does not exist in the repository. If its default branch was renamed, register its URL again to detect the new one.',
    });
    expect(existsSync(cacheOf(repository.id))).toBe(false);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
  });

  it('fails as not found or not public once the repository disappeared', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true });
    rmSync(remote.bare, { recursive: true, force: true });
    expect(await scan(repository)).toEqual({
      ok: false,
      code: 'auth-required',
      message: NOT_FOUND_OR_NOT_PUBLIC,
    });
    expect(existsSync(cacheOf(repository.id))).toBe(false);
    // The registry is unchanged: the artifacts of the earlier scan stay.
    expect(await handle.db.$count(schema.artifactOccurrences)).toBe(4);
  });

  it('stops and deletes the cache when the trees alone exceed the cache limit', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    const result = await scan(repository, { cacheLimitBytes: 1 });
    expect(result).toMatchObject({ ok: false, code: 'cache-limit-exceeded' });
    expect(existsSync(cacheOf(repository.id))).toBe(false);
  });

  it('stops when the candidate blobs exceed the cache limit', async () => {
    // Incompressible, so the blob itself, not only the trees, is above the limit.
    const random = randomBytes(400 * 1024);
    const remote = new FixtureRemote(remotes, 'acme', 'blobs', {
      'skill/SKILL.md': SKILL,
      'skill/data.txt': random,
    });
    const repository = await registered(remote);
    const result = await scan(repository, { cacheLimitBytes: 64 * 1024 });
    expect(result).toMatchObject({ ok: false, code: 'cache-limit-exceeded' });
    // Regression (review of PR #51): the oversized cache does not stay on disk.
    expect(existsSync(cacheOf(repository.id))).toBe(false);
  });

  it('fails when git is missing at scan time', async () => {
    const repository = await registered(teamSkills());
    expect(await scan(repository, { env: {} })).toMatchObject({
      ok: false,
      code: 'git-not-installed',
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
  });

  it('fails without a default branch, and for a stored location that is not normalised', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'empty');
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: false, code: 'branch-not-found' });
    const { repository: odd } = await registerHostedRepository(handle.db, {
      provider: 'github',
      name: 'odd',
      location: 'https://github.com/Acme/odd',
      defaultBranch: 'main',
    });
    expect(await scan(odd)).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The stored repository location is invalid.',
    });
  });

  it('rejects a tree with a path that is not normalised before downloading anything', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'crafted', { 'AGENTS.md': '# ok\n' });
    const blob = remote.blob('AGENTS.md');
    const inner = git(remote.work, ['mktree'], `100644 blob ${blob}\tAGENTS.md\n`).trim();
    const tree = git(
      remote.work,
      ['mktree'],
      `040000 tree ${inner}\t..\n100644 blob ${blob}\tAGENTS.md\n`,
    ).trim();
    const commit = git(remote.work, ['commit-tree', tree, '-m', 'crafted'], '').trim();
    git(remote.bare, ['fetch', '-q', remote.work, `+${commit}:refs/heads/main`]);
    const repository = await registered(remote);
    expect(await scan(repository)).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The repository tree is invalid.',
    });
    expect(objectsIn(cacheOf(repository.id)).filter((o) => o.type === 'blob')).toEqual([]);
  });

  posixOnly('rejects a file name that is not valid UTF-8', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'latin1', { 'AGENTS.md': '# ok\n' });
    writeFileSync(
      join(
        Buffer.from(remote.work).toString(),
        Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('latin1'),
      ),
      'x',
    );
    const name = Buffer.concat([Buffer.from(`${remote.work}/`), Buffer.from([0x6e, 0xe9])]);
    writeFileSync(name, 'x');
    remote.commit({});
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: false, code: 'git-failed' });
    // A failed listing deletes the cache.
    expect(existsSync(cacheOf(repository.id))).toBe(false);
  });

  it('runs end to end in the LocalRunner: registration and scan jobs', async () => {
    const remote = teamSkills();
    const runner = new LocalRunner({
      handle,
      fixtureStore: join(dataDir, 'fixtures'),
      cacheDir: cacheDir(),
      adapters: new Map(),
      workspaceRoot: join(dataDir, 'workspaces'),
      hostedGitTransport: fileTransport(remotes),
      hostedGitLimits: { cacheSizePollIntervalMs: 5 },
    });
    const registration = await enqueueRepositoryRegistrationJob(handle.db, {
      url: remote.location,
    });
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    const outcome = await getRepositoryRegistration(handle.db, registration.id);
    expect(outcome).toMatchObject({ source: 'url', result: { ok: true, created: true } });
    const repositoryId = outcome?.repository?.id ?? '';
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    expect((await getRepositoryScan(handle.db, job.id))?.result).toMatchObject({
      ok: true,
      discovered: 4,
      commitSha: remote.head(),
    });
    // A failed hosted scan is a failed job with its typed outcome kept.
    rmSync(remote.bare, { recursive: true, force: true });
    const again = await enqueueRepositoryScanJob(handle, { repositoryId });
    expect(await runner.runUntilIdle()).toMatchObject([
      { status: 'failed', error: NOT_FOUND_OR_NOT_PUBLIC },
    ]);
    expect((await getRepositoryScan(handle.db, again.job.id))?.result).toMatchObject({
      code: 'auth-required',
    });
    expect(FIXTURE_GIT_ENV.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });
});
