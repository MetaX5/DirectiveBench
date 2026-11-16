import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverArtifacts } from '@directivebench/core';
import {
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  finishJob,
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
  REPOSITORY_ID,
  ScanCancelledError,
  hostedScanConfigHash,
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
import {
  ASSIGNED_METADATA,
  assignUserMetadata,
  userMetadata,
  versionHistory,
  withOneNewVersion,
} from './support/rescan';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');
/**
 * Every test here runs real git against a fixture remote, most of them over several commits and
 * scans: 1 to 1.5 s each under `taskset -c 0,1 pnpm test --force`, and one took 5.4 s on the
 * 2-core CI runner, over vitest's 5 s default (issue #232).
 */
const REAL_GIT_TEST_TIMEOUT_MS = 30_000;
const realGit = { timeout: REAL_GIT_TEST_TIMEOUT_MS };

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
  const result = await registerHostedUrl(handle, { url: remote.location }, options());
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

describe('hosted copies never link (SPEC-126 A16)', realGit, () => {
  it('keeps the same skill in two GitHub repositories as two artifacts', async () => {
    const files = { 'skills/review/SKILL.md': SKILL };
    const first = await registered(new FixtureRemote(remotes, 'acme', 'first', files));
    const second = await registered(new FixtureRemote(remotes, 'acme', 'second', files));
    expect(await scan(first)).toMatchObject({
      ok: true,
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
    expect(await scan(second)).toMatchObject({
      ok: true,
      createdArtifacts: 1,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
      movedOccurrences: 0,
      ambiguousMoves: 0,
    });
    expect(await handle.db.$count(schema.artifacts)).toBe(2);
  });
});

describe('hosted scans keep identity across moves (SPEC-126 Phase 3)', realGit, () => {
  const NAMELESS = (text: string) => `---\ndescription: ${text}\n---\n# ${text}\n`;
  const RULE = '---\nglobs: "*.ts"\n---\nUse named exports.\n';

  function rows(): Map<string, { id: string; status: string; version: number }> {
    return new Map(
      handle.sqlite
        .prepare(
          `select o.path, o.id, o.status, v.version
             from artifact_occurrences o
             join artifact_versions v on v.id = o.latest_version_id`,
        )
        .all()
        .map((row) => [
          String(row.path),
          { id: String(row.id), status: String(row.status), version: Number(row.version) },
        ]),
    );
  }

  it('moves a skill directory and renames a rule between commits, and leaves two identical moved skills apart', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'moves', {
      'AGENTS.md': '# Rules\n',
      'skills/review/SKILL.md': NAMELESS('Review'),
      '.cursor/rules/no-default-export.mdc': RULE,
      'pair/x/SKILL.md': NAMELESS('Twin'),
      'pair/y/SKILL.md': NAMELESS('Twin'),
    });
    const repository = await registered(remote);
    await scan(repository);
    const before = rows();
    const move = (from: string, to: string) => {
      mkdirSync(join(remote.work, to, '..'), { recursive: true });
      git(remote.work, ['mv', from, to]);
    };

    move('skills/review', '.agents/skills/code-review');
    move('.cursor/rules/no-default-export.mdc', '.cursor/rules/no-default-exports.mdc');
    const head = remote.commit({}, 'move');
    expect(await scan(repository)).toMatchObject({
      ok: true,
      commitSha: head,
      createdArtifacts: 0,
      createdVersions: 1,
      movedOccurrences: 2,
      ambiguousMoves: 0,
      removedOccurrences: 0,
    });
    const moved = rows();
    expect(moved.get('.agents/skills/code-review')).toEqual({
      ...before.get('skills/review'),
      version: 1,
    });
    expect(moved.get('.cursor/rules/no-default-exports.mdc')).toEqual({
      ...before.get('.cursor/rules/no-default-export.mdc'),
      version: 2,
    });

    move('pair/x', 'moved/x');
    move('pair/y', 'moved/y');
    remote.commit({}, 'move twins');
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdArtifacts: 2,
      movedOccurrences: 0,
      ambiguousMoves: 2,
      removedOccurrences: 2,
    });
  });
});

describe(
  'hosted rescans after a rename and a type change (issue 66, SPEC-103 FR-103-16)',
  realGit,
  () => {
    it('keeps the artifact and slug through a rename, and the type follows a format change', async () => {
      const skill = (name: string) => `---\nname: ${name}\ndescription: D.\n---\n# ${name}\n`;
      const remote = new FixtureRemote(remotes, 'acme', 'renames', {
        'docs/AGENTS.md': '# Docs\n',
        'skills/review/SKILL.md': skill('review'),
      });
      const repository = await registered(remote);
      await scan(repository);
      const rows = () =>
        new Map(
          handle.sqlite
            .prepare(
              `select o.path, a.id, a.slug, a.name, a.type
               from artifact_occurrences o join artifacts a on a.id = o.artifact_id
              where o.status = 'active'`,
            )
            .all()
            .map((row) => [
              String(row.path),
              {
                id: String(row.id),
                slug: String(row.slug),
                name: String(row.name),
                type: String(row.type),
              },
            ]),
        );
      const before = rows();
      git(remote.work, ['rm', '-q', 'docs/AGENTS.md']);
      const head = remote.commit({
        'docs/AGENTS.md/SKILL.md': skill('docs-skill'),
        'skills/review/SKILL.md': skill('code-review'),
      });
      expect(await scan(repository)).toMatchObject({
        ok: true,
        commitSha: head,
        createdArtifacts: 0,
        createdVersions: 2,
        removedOccurrences: 0,
      });
      const after = rows();
      expect(after.get('skills/review')).toEqual({
        ...before.get('skills/review'),
        name: 'code-review',
      });
      expect(after.get('docs/AGENTS.md')).toEqual({
        ...before.get('docs/AGENTS.md'),
        name: 'docs-skill',
        type: 'skill',
      });
    });
  },
);

describe('registerHostedUrl', realGit, () => {
  it('registers a public repository with provider github and its default branch, without credentials', async () => {
    const remote = teamSkills();
    git(remote.bare, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    git(remote.bare, ['update-ref', 'refs/heads/trunk', remote.head()]);
    const result = await registerHostedUrl(
      handle,
      { url: 'https://github.com/Acme/Team-Skills.git' },
      options(),
    );
    expect(result).toMatchObject({ ok: true, created: true });
    const [repository] = await handle.db.select().from(schema.repositories);
    expect(repository).toMatchObject({
      provider: 'github',
      name: 'Acme/Team-Skills',
      location: 'https://github.com/acme/team-skills',
      defaultBranch: 'trunk',
      selectedBranch: null,
      syncStatus: 'never',
    });
    // Registration downloads nothing: no cache exists yet, only the private layout.
    expect(readdirSync(join(cacheDir(), 'repos'))).toEqual([]);
    for (const dir of [cacheDir(), join(cacheDir(), 'repos'), join(cacheDir(), 'git-home')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(cacheDir(), 'git-home'))).toEqual([]);
    // The same repository again returns the existing row.
    expect(await registerHostedUrl(handle, { url: remote.location }, options())).toEqual({
      ok: true,
      repositoryId: repository?.id,
      created: false,
    });
  });

  it('stores no default branch for an empty repository, and detects it on a new registration', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'empty');
    expect(await registerHostedUrl(handle, { url: remote.location }, options())).toMatchObject({
      ok: true,
    });
    const [empty] = await handle.db.select().from(schema.repositories);
    expect(empty?.defaultBranch).toBeNull();
    expect(await scan(empty as RepositoryRecord)).toMatchObject({ code: 'branch-not-found' });
    // Regression (review of PR #51): registering the URL again is the way out the error names.
    remote.commit({ 'AGENTS.md': '# Rules\n' });
    expect(await registerHostedUrl(handle, { url: remote.location }, options())).toMatchObject({
      ok: true,
      created: false,
    });
    const repository = (await getRepository(handle.db, String(empty?.id))) as RepositoryRecord;
    expect(repository.defaultBranch).toBe('main');
    expect(await scan(repository)).toMatchObject({ ok: true, discovered: 1 });
  });

  it('rejects a missing repository as not found or not public and stores nothing', async () => {
    const result = await registerHostedUrl(
      handle,
      { url: 'https://github.com/acme/missing' },
      options(),
    );
    expect(result).toEqual({ ok: false, code: 'auth-required', message: NOT_FOUND_OR_NOT_PUBLIC });
    expect(await handle.db.$count(schema.repositories)).toBe(0);
  });

  it('rejects an invalid URL without running git', async () => {
    const result = await registerHostedUrl(
      handle,
      { url: 'https://user:pw@github.com/a/b' },
      options(),
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid-url' });
    expect(existsSync(cacheDir())).toBe(false);
  });

  it('reports a missing git', async () => {
    const result = await registerHostedUrl(
      handle,
      { url: 'https://github.com/a/b' },
      options({ env: {} }),
    );
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
      { url: 'https://github.com/a/b' },
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
      { url: remote.location },
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
      registerHostedUrl(
        handle,
        { url: 'https://github.com/a/b' },
        options({ signal: controller.signal }),
      ),
    ).rejects.toThrow(GitCancelledError);
  });
});

describe('scanHostedRepository', realGit, () => {
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
      // A hosted scan never skips user-level folders (D05 applies to local paths): 0, not absent.
      skippedUserLevelFolders: [],
      skippedUserLevelFolderCount: 0,
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

  // Issue #19 (SPEC-013 M1 AC2, SPEC-103 FR-103-06/07, SPEC-001 principle 15).
  it('versions only changed content on a rescan of new commits and keeps what the user assigned', async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true, createdVersions: 4 });
    const first = versionHistory(handle);
    const skill = first['.agents/skills/review']?.artifactId ?? '';
    await assignUserMetadata(handle, skill);

    // A new commit that changes no artifact: 0 new versions; the occurrences record the commit.
    const readme = remote.commit({ 'README.md': '# Edited, still not an artifact\n' });
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdArtifacts: 0,
      createdVersions: 0,
      commitSha: readme,
    });
    expect(versionHistory(handle)).toEqual(first);
    const commits = () =>
      handle.sqlite
        .prepare('select distinct commit_sha as sha from artifact_occurrences')
        .all()
        .map((row) => row.sha);
    expect(commits()).toEqual([readme]);

    // One edited file — a supporting file of the skill — is one new version of that artifact,
    // first observed at the commit that changed it.
    const edit = remote.commit({
      '.agents/skills/review/references/checklist.md': '# Checklist, edited\n',
    });
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdArtifacts: 0,
      createdVersions: 1,
      commitSha: edit,
    });
    const second = versionHistory(handle);
    expect(second).toEqual(withOneNewVersion(first, '.agents/skills/review'));
    expect(
      handle.sqlite
        .prepare('select source_commit_sha as sha from artifact_versions where version = 2')
        .all()
        .map((row) => row.sha),
    ).toEqual([edit]);
    expect(await userMetadata(handle, skill)).toEqual(ASSIGNED_METADATA);

    // A revert reuses the earlier version (FR-103-07); the edit's version is kept.
    const revert = remote.commit({
      '.agents/skills/review/references/checklist.md': '# Checklist\n',
    });
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdVersions: 0,
      commitSha: revert,
    });
    expect(versionHistory(handle)).toEqual({
      ...second,
      '.agents/skills/review': { ...second['.agents/skills/review'], latest: 1 },
    });
    expect(commits()).toEqual([revert]);
    expect(await userMetadata(handle, skill)).toEqual(ASSIGNED_METADATA);
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
      { url: remote.location },
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
      const { env } = buildHostedGitEnv({ PATH: process.env.PATH }, home, 'local', gitDir, null);
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
    // GIT_DIR alone, without the ceiling: in a cache that is no repository git does not walk up
    // to the enclosing one.
    const broken = join(cache, 'repos', 'broken.git');
    writeFiles(broken, { garbage: 'not a repository' });
    const { env } = buildHostedGitEnv({ PATH: process.env.PATH }, home, 'local', broken, null);
    delete env.GIT_CEILING_DIRECTORIES;
    const unbounded = execFileSync(
      'git',
      hostedGitArgs('file', ['config', '--show-origin', '--list']),
      { cwd: broken, env },
    ).toString();
    expect(unbounded).not.toContain('.git/config');
    expect(unbounded).not.toContain('insteadof');
  });

  posixOnly('refuses a data directory whose path contains the path list delimiter', async () => {
    const remote = teamSkills();
    const cache = join(remotes, 'a:b', 'cache');
    const registration = await registerHostedUrl(
      handle,
      { url: remote.location },
      options({ cacheDir: cache }),
    );
    const scanned = await scan(await registered(remote), { cacheDir: cache });
    for (const result of [registration, scanned]) {
      expect(result).toMatchObject({ ok: false, code: 'git-failed' });
      const { message } = result as { message: string };
      expect(message).toContain('contains no ":"');
      expect(message).not.toContain(remotes);
    }
    expect(existsSync(cache)).toBe(false);
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

  it("names git's error line, not the clone progress line, for a clone that fails (issue #195)", async () => {
    const remote = teamSkills();
    const repository = await registered(remote);
    // Without its root tree the remote cannot pack the commit. git 2.53 prints "Cloning into bare
    // repository '…'...", the remote's "remote: fatal: bad tree object …", then its own
    // `error:`/`fatal:` lines, none of which a classifier pattern knows.
    const tree = git(remote.bare, ['rev-parse', 'refs/heads/main^{tree}']).trim();
    rmSync(join(remote.bare, 'objects', tree.slice(0, 2), tree.slice(2)));
    expect(await scan(repository)).toEqual({
      ok: false,
      code: 'git-failed',
      message: 'git failed: git upload-pack: git-pack-objects died with error.',
    });
    expect(existsSync(cacheOf(repository.id))).toBe(false);
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
      selectedBranch: null,
    });
    expect(await scan(odd)).toEqual({
      ok: false,
      code: 'scan-failed',
      message: 'The stored repository location is invalid.',
    });
  });

  it('refuses an id DirectiveBench does not create before touching the cache (issue 59 J6)', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'ids', { 'AGENTS.md': '# Rules\n' });
    const repository = await registered(remote);
    expect(repository.id).toMatch(REPOSITORY_ID);
    for (const id of ['repo-1', 'repo_1', `${repository.id}x`]) {
      expect(
        await scanHostedRepository(
          handle,
          { jobId: 'job_x', repository: { ...repository, id } },
          options(),
        ),
      ).toEqual({
        ok: false,
        code: 'scan-failed',
        message: 'The stored repository location is invalid.',
      });
    }
    expect(readdirSync(join(cacheDir(), 'repos'))).toEqual([]);
    expect(await scan(repository)).toMatchObject({ ok: true });
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

  it('scans a tree whose entries carry legacy or unusual modes: git canonicalises them (issue #61)', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'legacy-modes', { 'README.md': '# x\n' });
    const agents = git(remote.bare, ['hash-object', '-w', '--stdin'], '# Rules\n').trim();
    const claude = git(remote.bare, ['hash-object', '-w', '--stdin'], '# Claude\n').trim();
    // Raw tree bytes, as old git versions and other tools wrote them (`git mktree` would
    // normalise the modes): `<mode> <name>\0<binary oid>`, sorted by name.
    const entry = (mode: string, name: string, oid: string) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
    const raw = Buffer.concat([
      entry('100664', 'AGENTS.md', agents),
      entry('100000', 'CLAUDE.md', claude),
      entry('140000', 'GEMINI.md', claude),
    ]);
    const tree = git(
      remote.bare,
      ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'],
      raw,
    ).trim();
    // The stored object keeps the modes as written (even `cat-file -p` would show them normalised).
    expect(git(remote.bare, ['cat-file', 'tree', tree])).toContain('100664 AGENTS.md');
    const commit = git(remote.bare, ['commit-tree', tree, '-m', 'legacy modes'], '').trim();
    git(remote.bare, ['update-ref', 'refs/heads/main', commit]);
    // What the scan lists: regular files as 100644, anything unknown as a submodule (160000).
    expect(git(remote.bare, ['ls-tree', '-r', '--full-tree', commit])).toBe(
      `100644 blob ${agents}\tAGENTS.md\n100644 blob ${claude}\tCLAUDE.md\n160000 commit ${claude}\tGEMINI.md\n`,
    );
    const repository = await registered(remote);
    const result = await scan(repository);
    expect(result).toMatchObject({ ok: true, scannedFiles: 2, discovered: 2, errorCount: 0 });
    const paths = handle.sqlite
      .prepare('select path from artifact_occurrences order by path')
      .all()
      .map((row) => (row as { path: string }).path);
    expect(paths).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('rejects a file name that is not valid UTF-8', async () => {
    const remote = new FixtureRemote(remotes, 'acme', 'latin1', { 'AGENTS.md': '# ok\n' });
    // "café" in Latin-1: git keeps the bytes, which are not UTF-8.
    remote.commitRawPath(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'x');
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

describe('missing occurrences of a hosted repository (SPEC-125)', realGit, () => {
  const statuses = () =>
    handle.sqlite
      .prepare('select path, status from artifact_occurrences order by path')
      .all()
      .map((row) => [row.path, row.status]);

  function skills(): FixtureRemote {
    return new FixtureRemote(remotes, 'acme', 'missing', {
      'AGENTS.md': '# Rules\n',
      'review/SKILL.md': SKILL,
      'other/SKILL.md': SKILL.replace('review', 'other'),
    });
  }

  it('marks a deleted skill missing, reactivates it when restored, and keeps all on an empty commit', async () => {
    const remote = skills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true, discovered: 3 });

    git(remote.work, ['rm', '-q', '-r', 'review']);
    remote.commit({}, 'delete review');
    expect(await scan(repository)).toMatchObject({
      ok: true,
      removedOccurrences: 1,
      reactivatedOccurrences: 0,
      emptyScanKeptOccurrences: 0,
    });
    expect(statuses()).toEqual([
      ['AGENTS.md', 'active'],
      ['other', 'active'],
      ['review', 'removed'],
    ]);

    remote.commit({ 'review/SKILL.md': SKILL }, 'restore review');
    expect(await scan(repository)).toMatchObject({
      ok: true,
      createdVersions: 0,
      removedOccurrences: 0,
      reactivatedOccurrences: 1,
    });
    expect(statuses().every(([, status]) => status === 'active')).toBe(true);

    // A commit without any artifact: the empty-scan guard keeps all three (A7).
    git(remote.work, ['rm', '-q', '-r', '.']);
    remote.commit({ 'README.md': '# Emptied\n' }, 'delete everything');
    expect(await scan(repository)).toMatchObject({
      ok: true,
      discovered: 0,
      removedOccurrences: 0,
      emptyScanKeptOccurrences: 3,
    });
    expect(statuses().every(([, status]) => status === 'active')).toBe(true);
  });

  it('marks nothing when the cache limit, the read limit or a git time limit stops the scan', async () => {
    const remote = skills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true });
    git(remote.work, ['rm', '-q', '-r', 'review']);
    remote.commit({}, 'delete review');
    expect(await scan(repository, { cacheLimitBytes: 1 })).toMatchObject({
      ok: false,
      code: 'cache-limit-exceeded',
    });
    expect(await scan(repository, { readTotalBytes: 1 })).toMatchObject({
      ok: false,
      code: 'scan-failed',
    });
    expect(await scan(repository, { timeouts: { fetch: 0 } })).toMatchObject({
      ok: false,
      code: 'timeout',
    });
    expect(statuses().every(([, status]) => status === 'active')).toBe(true);
    expect(await scan(repository)).toMatchObject({ ok: true, removedOccurrences: 1 });
  });
});

describe(
  'an unchanged remote skips the fetch and the scan (issue 63, SPEC-105 FR-105-10)',
  realGit,
  () => {
    const VERSION = '1.0.0';
    let gitLog: string;
    let gitBin: string;

    beforeEach(() => {
      // A git on PATH that logs every call and runs the real git: the subcommands show whether a
      // scan fetched anything.
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

    /** The subcommands git ran since the last call, without the `-c` pairs before them. */
    function gitCommands(): string[] {
      if (!existsSync(gitLog)) return [];
      const lines = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean);
      rmSync(gitLog);
      return lines.map((line) => {
        const args = line.split(' ');
        let i = 0;
        while (args[i] === '-c') i += 2;
        return String(args[i]);
      });
    }

    /** A scan as the runner runs it: a running job, the hosted scan, then the job's outcome. */
    async function rescan(
      repository: RepositoryRecord,
      overrides: Partial<HostedRepositoryOptions> = {},
    ) {
      const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
      handle.sqlite.prepare(`update jobs set status = 'running' where id = ?`).run(job.id);
      const current = (await getRepository(handle.db, repository.id)) as RepositoryRecord;
      const result = await scanHostedRepository(
        handle,
        { jobId: job.id, repository: current },
        options({
          appVersion: VERSION,
          env: { PATH: `${gitBin}${delimiter}${process.env.PATH}` },
          ...overrides,
        }),
      );
      if (result.ok) await finishJob(handle.db, job.id, 'completed', undefined, result);
      else await finishJob(handle.db, job.id, 'failed', result.message, result);
      return { jobId: job.id, result };
    }

    const versionCount = () => handle.db.$count(schema.artifactVersions);
    const syncOf = (repositoryId: string) =>
      handle.sqlite
        .prepare('select last_sync_at, sync_status, sync_error from repositories where id = ?')
        .get(repositoryId);

    /** A transport that runs `hook` once, when git is first given the remote URL after arming. */
    function hooked(hook: () => void) {
      let armed = false;
      return {
        arm: () => {
          armed = true;
        },
        transport: {
          protocol: 'file' as const,
          remoteUrl: (location: string) => {
            if (armed) {
              armed = false;
              hook();
            }
            return fileTransport(remotes).remoteUrl(location);
          },
        },
      };
    }

    posixOnly(
      'rescans an unchanged remote with ls-remote alone and records it unchanged with 0 versions',
      async () => {
        const remote = teamSkills();
        const repository = await registered(remote);
        const { result: first } = await rescan(repository);
        expect(first).toMatchObject({
          ok: true,
          createdArtifacts: 4,
          commitSha: remote.head(),
          scanConfigHash: hostedScanConfigHash(VERSION, 'main'),
        });
        expect(first.ok && first.unchanged).toBeFalsy();
        expect(gitCommands()).toContain('clone');
        const versions = await versionCount();
        const before = syncOf(repository.id);
        if (!first.ok) throw new Error(first.message);

        const { jobId, result: second } = await rescan(repository);
        expect(gitCommands()).toEqual(['version', 'ls-remote']);
        expect(second).toEqual({
          ok: true,
          unchanged: true,
          branch: 'main',
          scannedFiles: first.scannedFiles,
          discovered: first.discovered,
          createdArtifacts: 0,
          createdVersions: 0,
          removedOccurrences: 0,
          reactivatedOccurrences: 0,
          emptyScanKeptOccurrences: first.emptyScanKeptOccurrences,
          linkedOccurrences: 0,
          ambiguousLinks: 0,
          movedOccurrences: 0,
          ambiguousMoves: 0,
          warningCount: first.warningCount,
          errorCount: first.errorCount,
          errors: first.errors,
          skippedUserLevelFolders: [],
          // Like the full GitHub scan: user-level folders are never read from a hosted repository.
          skippedUserLevelFolderCount: 0,
          commitSha: first.commitSha,
          scanConfigHash: first.scanConfigHash,
          durationMs: expect.any(Number) as number,
        });
        expect(await versionCount()).toBe(versions);
        expect(syncOf(repository.id)).toMatchObject({ sync_status: 'ok', sync_error: null });
        expect(String(syncOf(repository.id)?.last_sync_at) > String(before?.last_sync_at)).toBe(
          true,
        );
        // The stored outcome parses for the Repositories page, which shows it like any rescan.
        expect((await getRepositoryScan(handle.db, jobId))?.result).toMatchObject({
          ok: true,
          unchanged: true,
          createdVersions: 0,
          skippedUserLevelFolderCount: 0,
        });

        // An unchanged scan is itself a baseline for the next one.
        expect((await rescan(repository)).result).toMatchObject({ ok: true, unchanged: true });
        expect(gitCommands()).toEqual(['version', 'ls-remote']);
      },
    );

    posixOnly('scans a changed remote as before', async () => {
      const remote = teamSkills();
      const repository = await registered(remote);
      await rescan(repository);
      await rescan(repository);
      gitCommands();
      const head = remote.commit({ '.agents/skills/review/SKILL.md': `${SKILL}More.\n` }, 'edit');
      const { result } = await rescan(repository);
      expect(result).toMatchObject({ ok: true, createdVersions: 1, commitSha: head });
      expect(result.ok && result.unchanged).toBeFalsy();
      expect(gitCommands()).toEqual(expect.arrayContaining(['ls-remote', 'fetch', 'ls-tree']));
    });

    posixOnly('scans when the scan configuration changed or was not recorded', async () => {
      const remote = teamSkills();
      const repository = await registered(remote);
      await rescan(repository);
      gitCommands();
      expect(hostedScanConfigHash('1.0.1', 'main')).toMatch(/^[0-9a-f]{64}$/);
      expect(hostedScanConfigHash('1.0.1', 'main')).not.toBe(hostedScanConfigHash(VERSION, 'main'));

      // Another DirectiveBench version reads the same commit again, once.
      const { result: upgraded } = await rescan(repository, { appVersion: '1.0.1' });
      expect(upgraded).toMatchObject({
        ok: true,
        scanConfigHash: hostedScanConfigHash('1.0.1', 'main'),
      });
      expect(upgraded.ok && upgraded.unchanged).toBeFalsy();
      expect(gitCommands()).toContain('ls-tree');
      const { jobId, result: again } = await rescan(repository, { appVersion: '1.0.1' });
      expect(again).toMatchObject({ ok: true, unchanged: true });
      gitCommands();

      // A result stored before the hash existed is no baseline (issue 63 fallback: scan).
      const stored = JSON.parse(
        String(handle.sqlite.prepare('select result from jobs where id = ?').get(jobId)?.result),
      ) as Record<string, unknown>;
      delete stored.scanConfigHash;
      handle.sqlite
        .prepare('update jobs set result = ? where id = ?')
        .run(JSON.stringify(stored), jobId);
      expect((await rescan(repository, { appVersion: '1.0.1' })).result).toMatchObject({
        ok: true,
      });
      expect(gitCommands()).toContain('ls-tree');

      // A runner that does not know its version never skips, and records no hash (fail closed).
      const { result: unknown } = await rescan(repository, { appVersion: undefined });
      expect(unknown.ok && unknown.scanConfigHash).toBeUndefined();
      expect(gitCommands()).not.toContain('ls-remote');
      expect((await rescan(repository)).result).toMatchObject({ ok: true });
      expect(gitCommands()).toContain('ls-tree');
    });

    posixOnly(
      'scans when the last scan failed or the repository is not synced at the last scanned commit',
      async () => {
        const remote = teamSkills();
        const repository = await registered(remote);
        await rescan(repository);
        gitCommands();
        handle.sqlite
          .prepare(`update repositories set sync_status = 'error', sync_error = 'x' where id = ?`)
          .run(repository.id);
        expect((await rescan(repository)).result).toMatchObject({ ok: true });
        expect(gitCommands()).toContain('ls-tree');
        expect(syncOf(repository.id)).toMatchObject({ sync_status: 'ok', sync_error: null });
        handle.sqlite
          .prepare(`update repositories set last_commit_sha = ? where id = ?`)
          .run('f'.repeat(40), repository.id);
        expect((await rescan(repository)).result).toMatchObject({ ok: true });
        expect(gitCommands()).toContain('ls-tree');
      },
    );

    posixOnly(
      'fails when the remote head check fails, and scans when the branch is gone',
      async () => {
        const remote = teamSkills();
        const repository = await registered(remote);
        await rescan(repository);
        gitCommands();
        rmSync(remote.bare, { recursive: true, force: true });
        expect((await rescan(repository)).result).toEqual({
          ok: false,
          code: 'auth-required',
          message: NOT_FOUND_OR_NOT_PUBLIC,
        });
        expect(gitCommands()).toEqual(['version', 'ls-remote']);
        expect(syncOf(repository.id)).toMatchObject({ sync_status: 'error' });

        const other = new FixtureRemote(remotes, 'acme', 'branchless', {
          'AGENTS.md': '# Rules\n',
        });
        const branchless = await registered(other);
        await rescan(branchless);
        git(other.bare, ['update-ref', '-d', 'refs/heads/main']);
        gitCommands();
        expect((await rescan(branchless)).result).toMatchObject({
          ok: false,
          code: 'branch-not-found',
        });
        expect(gitCommands()).toEqual(expect.arrayContaining(['ls-remote', 'fetch']));
      },
    );

    posixOnly(
      'scans in full when the repository changed between the head check and the write',
      async () => {
        const remote = teamSkills();
        const repository = await registered(remote);
        const hook = hooked(() => {
          handle.sqlite
            .prepare(`update repositories set sync_status = 'error' where id = ?`)
            .run(repository.id);
        });
        await rescan(repository, { transport: hook.transport });
        gitCommands();
        hook.arm();
        const { result } = await rescan(repository, { transport: hook.transport });
        expect(result).toMatchObject({ ok: true, createdVersions: 0 });
        expect(result.ok && result.unchanged).toBeFalsy();
        expect(gitCommands()).toEqual(expect.arrayContaining(['ls-remote', 'fetch', 'ls-tree']));
        expect(syncOf(repository.id)).toMatchObject({ sync_status: 'ok' });
      },
    );

    posixOnly('honours a cancellation and a removal that land during the head check', async () => {
      const remote = teamSkills();
      const repository = await registered(remote);
      const cancel = hooked(() => {
        handle.sqlite
          .prepare(`update jobs set cancel_requested_at = ? where status = 'running'`)
          .run(new Date().toISOString());
      });
      await rescan(repository, { transport: cancel.transport });
      const before = syncOf(repository.id);
      cancel.arm();
      await expect(rescan(repository, { transport: cancel.transport })).rejects.toBeInstanceOf(
        ScanCancelledError,
      );
      expect(syncOf(repository.id)).toEqual(before);
      // The runner records the cancelled job; do the same so the next scan gets a job of its own.
      handle.sqlite.prepare(`update jobs set status = 'cancelled' where status = 'running'`).run();

      const remove = hooked(() => {
        handle.sqlite.prepare('delete from repositories where id = ?').run(repository.id);
      });
      remove.arm();
      expect((await rescan(repository, { transport: remove.transport })).result).toEqual({
        ok: false,
        code: 'repository-not-found',
        message: 'The repository was removed during the scan.',
      });
    });

    it('skips an unchanged remote in the LocalRunner, which passes its version', async () => {
      const remote = teamSkills();
      const runner = new LocalRunner({
        handle,
        fixtureStore: join(dataDir, 'fixtures'),
        cacheDir: cacheDir(),
        adapters: new Map(),
        workspaceRoot: join(dataDir, 'workspaces'),
        hostedGitTransport: fileTransport(remotes),
        hostedGitLimits: { cacheSizePollIntervalMs: 5 },
        appVersion: VERSION,
      });
      const repository = await registered(remote);
      const results = [];
      for (let i = 0; i < 2; i++) {
        const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
        expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
        results.push((await getRepositoryScan(handle.db, job.id))?.result);
      }
      expect(results).toMatchObject([
        { ok: true, createdArtifacts: 4, scanConfigHash: hostedScanConfigHash(VERSION, 'main') },
        { ok: true, unchanged: true, createdArtifacts: 0, createdVersions: 0 },
      ]);
    });
  },
);
