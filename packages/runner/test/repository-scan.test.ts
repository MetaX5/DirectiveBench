import * as childProcess from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverArtifacts } from '@directivebench/core';
import {
  enqueueRepositoryScanJob,
  getJob,
  getRepository,
  getRepositoryScan,
  importArtifactVersion,
  migrateDatabase,
  openDatabase,
  registerLocalRepository,
  schema,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner } from '../src/index';

// Every process-spawning function stays real but observable: a scan must call none of them.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    fork: vi.fn(actual.fork),
  };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));

/** Fixture git commands ignore the developer's system and global config. */
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let handle: DatabaseHandle;
let dataDir: string;
let sources: string;
let marker: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-scan-data-'));
  // realpath: on macOS the temp directory is behind the /var → /private/var symlink.
  sources = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-scan-sources-')));
  marker = join(sources, 'executed.marker');
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  vi.unstubAllEnvs();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  for (const name of readdirSync(sources)) chmodSync(join(sources, name), 0o755);
  rmSync(sources, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
}

const touch = (path: string) => `#!/bin/sh\ntouch "${path}"\n`;

/**
 * A git work tree with every artifact format of the issue, a multi-file skill, decoys, skipped
 * directories, symlinks and hostile content: hooks, an fsmonitor, a filter driver, package
 * scripts and executable files that all create `marker` if anything ever runs them.
 */
function buildRepository(name = 'team-skills'): string {
  const repo = join(sources, name);
  mkdirSync(repo);
  childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd: repo,
    env: FIXTURE_GIT_ENV,
  });
  write(repo, {
    '.agents/skills/review/SKILL.md':
      '---\nname: review\ndescription: Review pull requests.\n---\n# Review\nSee [checklist](references/checklist.md).\n',
    '.agents/skills/review/references/checklist.md': '# Checklist\n',
    '.agents/skills/review/scripts/run.sh': touch(marker),
    '.agents/skills/review/templates/report.md': '# Report\n',
    'AGENTS.md': '# Repository rules\n',
    '.cursor/rules/react.mdc': '---\nglobs: "src/**/*.tsx"\nalwaysApply: false\n---\n# React\n',
    '.github/copilot-instructions.md': '# Copilot\n',
    'README.md': '# Not an artifact\n',
    'package.json': JSON.stringify({ scripts: { postinstall: `touch ${marker}` } }),
    '.gitattributes': '*.md filter=evil\n',
    'node_modules/pkg/SKILL.md': '---\nname: hidden\n---\n',
    '.git/hooks/post-checkout': touch(marker),
    '.git/hooks/post-index-change': touch(marker),
    '.git/fsmonitor.sh': touch(marker),
  });
  for (const script of [
    '.agents/skills/review/scripts/run.sh',
    '.git/hooks/post-checkout',
    '.git/hooks/post-index-change',
    '.git/fsmonitor.sh',
  ]) {
    chmodSync(join(repo, script), 0o755);
  }
  chmodSync(join(repo, 'AGENTS.md'), 0o755);
  const hostileConfig: [string, string][] = [
    ['core.fsmonitor', join(repo, '.git/fsmonitor.sh')],
    ['filter.evil.smudge', touch(marker)],
    ['filter.evil.clean', touch(marker)],
  ];
  for (const [key, value] of hostileConfig) {
    childProcess.execFileSync('git', ['config', key, value], { cwd: repo, env: FIXTURE_GIT_ENV });
  }
  // Symlinks: one at a candidate path (an error), one inside the skill (skipped), both pointing
  // outside the repository.
  const outside = join(sources, 'outside');
  write(outside, { 'CLAUDE.md': '# Outside\n', 'secret.md': 'secret\n' });
  symlinkSync(join(outside, 'CLAUDE.md'), join(repo, 'CLAUDE.md'));
  symlinkSync(join(outside, 'secret.md'), join(repo, '.agents/skills/review/secret.md'));
  return repo;
}

async function register(location: string, provider: 'local-git' | 'local-directory') {
  const outcome = await registerLocalRepository(
    handle,
    { provider, name: location.split('/').pop() ?? location, location, defaultBranch: null },
    { homeDirectory: join(sources, 'home'), confirmedLocation: location },
  );
  if (outcome.status !== 'registered') throw new Error('not registered');
  return outcome.repository;
}

function createRunner(overrides: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    ...overrides,
  });
}

async function scan(repositoryId: string) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  const [execution] = await createRunner().runUntilIdle();
  expect(execution).toMatchObject({ jobId: job.id, status: 'completed', error: null });
  const result = await getRepositoryScan(handle.db, job.id);
  if (!result?.result) throw new Error('scan has no result');
  return result.result;
}

interface StoredOccurrence {
  path: string;
  commitSha: string | null;
  type: string;
  format: string;
  primaryFile: string;
  sourceCommitSha: string | null;
  files: { path: string }[];
  parsedMetadata: Record<string, unknown>;
}

/** Occurrences joined with their artifact and latest version, by path (plain SQL for tests). */
function storedOccurrences(): StoredOccurrence[] {
  const rows = handle.sqlite
    .prepare(
      `select o.path, o.commit_sha as commitSha, a.type, v.format, v.primary_file as primaryFile,
              v.source_commit_sha as sourceCommitSha, v.files, v.parsed_metadata as parsedMetadata
         from artifact_occurrences o
         join artifacts a on a.id = o.artifact_id
         join artifact_versions v on v.id = o.latest_version_id
        order by o.path`,
    )
    .all() as unknown as (Omit<StoredOccurrence, 'files' | 'parsedMetadata'> & {
    files: string;
    parsedMetadata: string;
  })[];
  return rows.map((row) => ({
    ...row,
    files: JSON.parse(row.files) as { path: string }[],
    parsedMetadata: JSON.parse(row.parsedMetadata) as Record<string, unknown>,
  }));
}

describe('repository-scan jobs', () => {
  it('discovers every artifact of a repository with type, format, occurrence path and manifest', async () => {
    const repo = buildRepository();
    const repository = await register(repo, 'local-git');
    vi.clearAllMocks();

    const result = await scan(repository.id);

    expect(result).toMatchObject({
      ok: true,
      discovered: 4,
      createdArtifacts: 4,
      createdVersions: 4,
      errorCount: 1,
      errors: [
        {
          path: 'CLAUDE.md',
          code: 'symlink',
          message: 'CLAUDE.md is a symbolic link and is not followed',
        },
      ],
    });
    const occurrences = storedOccurrences();
    expect(occurrences.map((o) => [o.path, o.type, o.format, o.primaryFile])).toEqual([
      ['.agents/skills/review', 'skill', 'skill-md', 'SKILL.md'],
      ['.cursor/rules/react.mdc', 'rule', 'cursor-rule', 'react.mdc'],
      [
        '.github/copilot-instructions.md',
        'instruction',
        'copilot-instructions',
        'copilot-instructions.md',
      ],
      ['AGENTS.md', 'instruction', 'agents-md', 'AGENTS.md'],
    ]);
    // Every regular file of the skill is in the manifest (FR-102-12); the symlink is skipped.
    expect(occurrences[0]?.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/checklist.md',
      'scripts/run.sh',
      'templates/report.md',
    ]);
    expect(occurrences[0]?.parsedMetadata).toMatchObject({
      skipped: [{ path: 'secret.md', reason: 'symlink' }],
    });
    // The working tree is scanned: no commit is attributed.
    expect(occurrences.every((o) => o.commitSha === null && o.sourceCommitSha === null)).toBe(true);
    const stored = await getRepository(handle.db, repository.id);
    expect(stored).toMatchObject({ syncStatus: 'ok', syncError: null, lastCommitSha: null });
    expect(stored?.lastSyncAt).not.toBeNull();

    // Nothing ran: no process was spawned, no hook, filter, fsmonitor or script left a marker.
    expect(existsSync(marker)).toBe(false);
    for (const spawned of [
      childProcess.spawn,
      childProcess.spawnSync,
      childProcess.exec,
      childProcess.execSync,
      childProcess.execFile,
      childProcess.execFileSync,
      childProcess.fork,
    ]) {
      expect(spawned).not.toHaveBeenCalled();
    }
  });

  it('gives identical artifacts, order, hashes and warnings when the same tree is scanned twice', async () => {
    const repo = buildRepository();
    const repository = await register(repo, 'local-git');
    const first = await discoverArtifacts(repo);
    const firstResult = await scan(repository.id);
    const second = await discoverArtifacts(repo);
    const secondResult = await scan(repository.id);

    expect(second).toEqual(first);
    const { durationMs: _a, ...firstRest } = firstResult as Extract<
      typeof firstResult,
      { ok: true }
    >;
    const { durationMs: _b, ...secondRest } = secondResult as Extract<
      typeof secondResult,
      { ok: true }
    >;
    expect(secondRest).toEqual({ ...firstRest, createdArtifacts: 0, createdVersions: 0 });
    expect(await handle.db.$count(schema.artifactVersions)).toBe(4);
  });

  it('reads nothing outside the registered repository, including user-level skill folders', async () => {
    const home = join(sources, 'home');
    write(home, { '.claude/skills/global/SKILL.md': '---\nname: global\n---\n' });
    vi.stubEnv('HOME', home);
    write(sources, { 'sibling/AGENTS.md': '# Sibling\n' });
    const project = join(sources, 'project');
    write(project, { 'AGENTS.md': '# Project\n' });
    symlinkSync(join(sources, 'sibling'), join(project, 'linked-dir'));
    const repository = await register(project, 'local-directory');

    const result = await scan(repository.id);
    expect(result).toMatchObject({ ok: true, discovered: 1, errorCount: 0 });
    expect(storedOccurrences().map((o) => o.path)).toEqual(['AGENTS.md']);
  });

  it('refuses a registered location that was replaced by a symlink, and records the error', async () => {
    const project = join(sources, 'project');
    write(project, { 'AGENTS.md': '# Project\n' });
    const repository = await register(project, 'local-directory');
    const elsewhere = join(sources, 'elsewhere');
    write(elsewhere, { 'AGENTS.md': '# Elsewhere\n' });
    renameSync(project, join(sources, 'moved'));
    symlinkSync(elsewhere, project);

    const result = await scan(repository.id);
    expect(result).toEqual({
      ok: false,
      code: 'location-changed',
      message:
        'The registered location now resolves to another place (it was moved or replaced by a symbolic link). Register the directory again.',
    });
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      syncStatus: 'error',
      syncError: result.ok ? null : result.message,
    });
  });

  it('reports a missing directory, a file and an unreadable directory', async () => {
    const missing = await register(join(sources, 'missing'), 'local-directory');
    expect(await scan(missing.id)).toMatchObject({ ok: false, code: 'path-not-found' });

    writeFileSync(join(sources, 'file'), 'x');
    const file = await register(join(sources, 'file'), 'local-directory');
    expect(await scan(file.id)).toMatchObject({ ok: false, code: 'not-a-directory' });

    const locked = join(sources, 'locked');
    mkdirSync(locked);
    const unreadable = await register(locked, 'local-directory');
    chmodSync(locked, 0o000);
    expect(await scan(unreadable.id)).toMatchObject({
      ok: false,
      code: 'permission-denied',
      message: 'DirectiveBench cannot read the registered directory.',
    });

    const parent = join(sources, 'parent');
    mkdirSync(join(parent, 'child'), { recursive: true });
    const hidden = await register(join(parent, 'child'), 'local-directory');
    chmodSync(parent, 0o000);
    expect(await scan(hidden.id)).toMatchObject({
      ok: false,
      code: 'permission-denied',
      message: 'DirectiveBench cannot access the registered directory.',
    });
  });

  it('refuses the filesystem root, unknown repositories and non-local providers', async () => {
    const root = await handle.db
      .insert(schema.repositories)
      .values({
        id: 'repo_root',
        provider: 'local-directory',
        name: '/',
        location: '/',
        createdAt: 'now',
        updatedAt: 'now',
      })
      .returning();
    expect(await scan(root[0]?.id ?? '')).toEqual({
      ok: false,
      code: 'filesystem-root',
      message: 'The filesystem root cannot be scanned.',
    });

    await importArtifactVersion(handle, {
      repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/examples' },
      path: 'AGENTS.md',
      slug: 'agents-md',
      name: 'AGENTS.md',
      type: 'instruction',
      description: null,
      format: 'agents-md',
      primaryFile: 'AGENTS.md',
      files: [{ path: 'AGENTS.md', content: '#\n' }],
      parsedMetadata: {},
    });
    const bundled = handle.sqlite
      .prepare("select id from repositories where provider = 'bundled-examples'")
      .get() as { id: string } | undefined;
    // A scan job for a bundled repository can only exist if inserted directly.
    await handle.db.insert(schema.jobs).values({
      id: 'job_bundled',
      type: 'repository-scan',
      status: 'pending',
      payload: { repositoryId: bundled?.id ?? '' },
      createdAt: '2026-01-01T00:00:00Z',
    });
    await handle.db.insert(schema.jobs).values({
      id: 'job_missing',
      type: 'repository-scan',
      status: 'pending',
      payload: { repositoryId: 'repo_missing' },
      createdAt: '2026-01-01T00:00:01Z',
    });
    await createRunner().runUntilIdle();
    expect((await getJob(handle.db, 'job_bundled'))?.result).toMatchObject({
      ok: false,
      code: 'unsupported-provider',
    });
    expect((await getJob(handle.db, 'job_missing'))?.result).toEqual({
      ok: false,
      code: 'repository-not-found',
      message: 'The repository no longer exists.',
    });
  });

  it('fails a job whose payload no longer validates', async () => {
    await handle.db.insert(schema.jobs).values({
      id: 'job_bad',
      type: 'repository-scan',
      status: 'pending',
      payload: { repositoryId: '', path: '/etc' },
      createdAt: '2026-01-01T00:00:00Z',
    });
    const [execution] = await createRunner().runUntilIdle();
    expect(execution).toMatchObject({ jobId: 'job_bad', status: 'failed' });
    expect(execution?.error).toMatch(/^The stored scan request is invalid: /);
  });
});
