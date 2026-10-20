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
import type * as core from '@directivebench/core';
import { discoverArtifacts, MAX_FRONTMATTER_JSON_BYTES } from '@directivebench/core';
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
  withTransaction,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner } from '../src/index';
import { userLevelAgentFolders } from '../src/repository-scan';

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

// The scan's discovery stays real; a test can lower its limits (FR-102-16).
// `afterDiscovery` runs when discovery has finished, before the scan stores its results.
const discoveryHooks = vi.hoisted(() => ({
  limits: undefined as Partial<core.DiscoveryLimits> | undefined,
  afterDiscovery: null as ((signal: AbortSignal | undefined) => void) | null,
}));
vi.mock('@directivebench/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return {
    ...actual,
    discoverArtifacts: async (root: string, options?: core.DiscoveryOptions) => {
      const result = await actual.discoverArtifacts(root, {
        ...options,
        limits: discoveryHooks.limits,
      });
      discoveryHooks.afterDiscovery?.(options?.signal);
      return result;
    },
  };
});

/** Scanning a 1 MB primary file takes ~0.7 s locally and up to ~2 s on a loaded CI runner. */
const LARGE_SOURCE_TIMEOUT_MS = 20_000;

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
  discoveryHooks.limits = undefined;
  discoveryHooks.afterDiscovery = null;
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
    cacheDir: join(dataDir, 'cache'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    ...overrides,
  });
}

async function scan(repositoryId: string) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  const [execution] = await createRunner().runUntilIdle();
  const result = await getRepositoryScan(handle.db, job.id);
  if (!result?.result) throw new Error('scan has no result');
  // A scan that could not run is a failed job; its typed outcome stays in `jobs.result`.
  expect(execution).toMatchObject(
    result.result.ok
      ? { jobId: job.id, status: 'completed', error: null }
      : { jobId: job.id, status: 'failed', error: result.result.message },
  );
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

  it('always skips user-level agent folders, even in a confirmed home directory scan (D05)', async () => {
    const home = join(sources, 'home');
    write(home, {
      'AGENTS.md': '# Home rules\n',
      '.claude/skills/global/SKILL.md': '---\nname: global\n---\n',
      '.claude/CLAUDE.md': '# User-level Claude\n',
      '.codex/AGENTS.md': '# User-level Codex\n',
      '.agents/skills/user/SKILL.md': '---\nname: user\n---\n',
      '.cursor/rules/user.mdc': '---\nalwaysApply: true\n---\n',
      '.config/cursor/rules/x.mdc': '---\nalwaysApply: true\n---\n',
      // A project's own `.claude/skills` is not user-level and is scanned.
      'project/.claude/skills/local/SKILL.md': '---\nname: local\n---\n',
    });
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', '');
    const repository = await register(home, 'local-directory');

    const result = await scan(repository.id);
    expect(result).toMatchObject({
      ok: true,
      discovered: 2,
      errorCount: 0,
      skippedUserLevelFolders: ['.agents', '.claude', '.codex', '.config/cursor', '.cursor'],
    });
    expect(storedOccurrences().map((o) => o.path)).toEqual([
      'AGENTS.md',
      'project/.claude/skills/local',
    ]);
  });

  it('skips the user-level folders below an ancestor, behind symlinks and from the environment', async () => {
    const home = join(sources, 'home');
    write(home, { '.claude/skills/global/SKILL.md': '---\nname: global\n---\n' });
    // `~/.codex` is a symlink into a dotfiles folder that the scanned ancestor also contains.
    write(sources, {
      'dotfiles/codex/AGENTS.md': '# User-level Codex\n',
      'claude-config/CLAUDE.md': '# CLAUDE_CONFIG_DIR\n',
      'codex-home/AGENTS.md': '# CODEX_HOME\n',
      'xdg/cursor/rules/x.mdc': '---\nalwaysApply: true\n---\n',
      'projects/app/AGENTS.md': '# App\n',
      // Another user's home next to this one (as in /home/<user>), and a plain file.
      'other-user/.claude/skills/theirs/SKILL.md': '---\nname: theirs\n---\n',
      'other-user/.config/cursor/rules/y.mdc': '---\nalwaysApply: true\n---\n',
      'other-user/AGENTS.md': '# Their project rules\n',
      'notes.txt': 'not a directory\n',
    });
    symlinkSync(join(sources, 'dotfiles/codex'), join(home, '.codex'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(sources, 'xdg'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(sources, 'claude-config'));
    vi.stubEnv('CODEX_HOME', join(sources, 'codex-home'));
    const repository = await register(sources, 'local-directory');

    const result = await scan(repository.id);
    expect(result).toMatchObject({
      ok: true,
      skippedUserLevelFolders: [
        'claude-config',
        'codex-home',
        'dotfiles/codex',
        'home/.claude',
        'other-user/.claude',
        'other-user/.config/cursor',
        'xdg/cursor',
      ],
    });
    expect(storedOccurrences().map((o) => o.path)).toEqual([
      'other-user/AGENTS.md',
      'projects/app/AGENTS.md',
    ]);
  });

  it("skips a sibling home's agent folder under its symlink target inside an ancestor scan", async () => {
    const home = join(sources, 'home');
    write(home, { 'AGENTS.md': '# Home rules\n' });
    // `/home/bob/.claude` → `/home/dotfiles/bob-claude`: both spellings lie in the scanned tree.
    write(sources, {
      'dotfiles/bob-claude/CLAUDE.md': '# Bob user-level\n',
      'dotfiles/bob-claude/skills/theirs/SKILL.md': '---\nname: theirs\n---\n',
      'dotfiles/AGENTS.md': '# Dotfiles project rules\n',
    });
    mkdirSync(join(sources, 'bob'));
    symlinkSync(join(sources, 'dotfiles/bob-claude'), join(sources, 'bob/.claude'));
    vi.stubEnv('HOME', home);
    const repository = await register(sources, 'local-directory');

    const result = await scan(repository.id);
    expect(result).toMatchObject({ ok: true, skippedUserLevelFolders: ['dotfiles/bob-claude'] });
    expect(storedOccurrences().map((o) => o.path)).toEqual([
      'dotfiles/AGENTS.md',
      'home/AGENTS.md',
    ]);
    expect(await userLevelAgentFolders(home, {}, sources)).toEqual(
      expect.arrayContaining([join(sources, 'bob/.claude'), join(sources, 'dotfiles/bob-claude')]),
    );
  });

  it('keeps the project folders of a repository that sits next to the home directory', async () => {
    const home = join(sources, 'home');
    write(home, { '.claude/skills/global/SKILL.md': '---\nname: global\n---\n' });
    const neighbour = join(sources, 'team-repo');
    write(neighbour, { '.claude/skills/team/SKILL.md': '---\nname: team\n---\n' });
    vi.stubEnv('HOME', home);
    const repository = await register(neighbour, 'local-directory');

    expect(await scan(repository.id)).toMatchObject({ ok: true, skippedUserLevelFolders: [] });
    expect(storedOccurrences().map((o) => o.path)).toEqual(['.claude/skills/team']);
  });

  it('reads nothing from a registered location that is itself a user-level folder', async () => {
    const home = join(sources, 'home');
    write(home, { '.claude/skills/global/SKILL.md': '---\nname: global\n---\n' });
    vi.stubEnv('HOME', home);
    const repository = await register(join(home, '.claude', 'skills'), 'local-directory');

    expect(await scan(repository.id)).toMatchObject({
      ok: true,
      scannedFiles: 0,
      discovered: 0,
      skippedUserLevelFolders: ['.'],
    });
    expect(storedOccurrences()).toEqual([]);
  });

  it('lists the user-level folders of a home directory that cannot be resolved', async () => {
    const env = { XDG_CONFIG_HOME: 'relative/xdg', CLAUDE_CONFIG_DIR: 'relative', CODEX_HOME: '' };
    expect(await userLevelAgentFolders('/nonexistent-home', env, '/')).toEqual([
      '/nonexistent-home/.agents',
      '/nonexistent-home/.claude',
      '/nonexistent-home/.codex',
      '/nonexistent-home/.config/cursor',
      '/nonexistent-home/.cursor',
    ]);
    // A parent that cannot be listed contributes no sibling homes.
    expect(
      await userLevelAgentFolders('/nonexistent-parent/home', {}, '/nonexistent-parent'),
    ).toHaveLength(5);
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

  it('keeps the stored version of a skill it cannot read completely, or not at all', async () => {
    const repo = buildRepository();
    const repository = await register(repo, 'local-git');
    await scan(repository.id);
    const skillOccurrence = () =>
      handle.sqlite
        .prepare("select * from artifact_occurrences where path = '.agents/skills/review'")
        .get();
    const before = skillOccurrence();
    expect(await handle.db.$count(schema.artifactVersions)).toBe(4);

    // Changed content in a directory the scan cannot list: reading the rest of the skill would
    // store a new, incomplete version and make it the latest.
    writeFileSync(join(repo, '.agents/skills/review/templates/report.md'), '# Report v2\n');
    writeFileSync(join(repo, 'AGENTS.md'), '# Repository rules v2\n');
    const templates = join(repo, '.agents/skills/review/templates');
    chmodSync(templates, 0o000);
    try {
      expect(await scan(repository.id)).toMatchObject({
        ok: true,
        discovered: 3,
        createdVersions: 1,
        errors: expect.arrayContaining([
          {
            path: '.agents/skills/review/SKILL.md',
            code: 'read-failed',
            message:
              'Skill .agents/skills/review/SKILL.md is incomplete and was not discovered. Cannot read directory .agents/skills/review/templates (EACCES); its files were not scanned',
          },
        ]),
      });
    } finally {
      chmodSync(templates, 0o755);
    }
    // Same version, same status, same last-seen time: a read failure is neither a change nor a
    // removal.
    expect(skillOccurrence()).toEqual(before);
    expect(await handle.db.$count(schema.artifactVersions)).toBe(5);

    // The directory that holds the skills cannot be listed: the skill is not even a candidate.
    const skills = join(repo, '.agents/skills');
    chmodSync(skills, 0o000);
    try {
      expect(await scan(repository.id)).toMatchObject({
        ok: true,
        discovered: 3,
        createdVersions: 0,
        errors: expect.arrayContaining([
          {
            path: '.agents/skills',
            code: 'read-failed',
            message: 'Cannot read directory .agents/skills (EACCES); its files were not scanned',
          },
        ]),
      });
    } finally {
      chmodSync(skills, 0o755);
    }
    expect(skillOccurrence()).toEqual(before);
    expect(await handle.db.$count(schema.artifactVersions)).toBe(5);

    // Readable again: the change becomes the next version.
    expect(await scan(repository.id)).toMatchObject({ ok: true, createdVersions: 1 });
    expect(skillOccurrence()).not.toEqual(before);
  });

  it('aborts a scan whose content exceeds the per-scan byte limit and writes nothing', async () => {
    const project = join(sources, 'project');
    write(project, { 'AGENTS.md': '# Project rules\n', 'CLAUDE.md': '# Claude\n' });
    const repository = await register(project, 'local-directory');
    discoveryHooks.limits = { maxScanBytes: 20 };

    const result = await scan(repository.id);
    expect(result).toEqual({
      ok: false,
      code: 'scan-failed',
      message:
        'The scan failed: Discovery aborted: the discovered artifacts exceed the limit of 20 bytes per scan',
    });
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
    expect(await handle.db.$count(schema.artifactOccurrences)).toBe(0);
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      syncStatus: 'error',
      syncError: result.ok ? null : result.message,
      lastSyncAt: null,
    });
  });

  // Regression (review of PR #44 at 2d668f3): 99 aliases of a 1 MB string pass the alias limit
  // and were stored as ~100 MB of JSON for one file.
  it(
    'stores a skill whose aliases expand past the frontmatter JSON limit without its frontmatter',
    async () => {
      const project = join(sources, 'project');
      const long = 'x'.repeat(1024 * 1024 - 1000);
      write(project, {
        '.agents/skills/wide/SKILL.md': `---\nname: wide-name\ndescription: Wide.\na: &a "${long}"\nb: [${Array(99).fill('*a').join(', ')}]\n---\n# Wide\n`,
        'AGENTS.md': '# Project rules\n',
      });
      const repository = await register(project, 'local-directory');

      expect(await scan(repository.id)).toMatchObject({ ok: true, discovered: 2, errorCount: 0 });
      const [skill] = storedOccurrences();
      expect(skill?.path).toBe('.agents/skills/wide');
      // The whole block is discarded, so the name falls back to the skill's directory.
      expect(
        handle.sqlite.prepare("select name from artifacts where type = 'skill'").get(),
      ).toEqual({
        name: 'wide',
      });
      expect(skill?.parsedMetadata).toMatchObject({
        frontmatter: {},
        warnings: expect.arrayContaining([
          `Invalid frontmatter: frontmatter cannot be stored as JSON: it expands to more than ${MAX_FRONTMATTER_JSON_BYTES} bytes of JSON (the limit was reached under the key "b")`,
        ]) as unknown,
      });
      const stored = handle.sqlite
        .prepare('select max(length(parsed_metadata)) as size from artifact_versions')
        .get() as { size: number };
      expect(stored.size).toBeLessThan(10_000);
    },
    LARGE_SOURCE_TIMEOUT_MS,
  );

  it('stores an artifact whose frontmatter JSON cannot represent, with a warning, next to the others', async () => {
    // YAML is not JSON: a self-referring alias parses to a circular object. Stored as is, it
    // threw inside the one scan transaction and failed every scan of the repository.
    const project = join(sources, 'project');
    write(project, {
      '.agents/skills/loop/SKILL.md':
        '---\nname: loop\ndescription: Loops.\nmetadata: &a {self: *a}\n---\n# Loop\n',
      'AGENTS.md': '# Project rules\n',
    });
    const repository = await register(project, 'local-directory');

    const result = await scan(repository.id);
    expect(result).toMatchObject({ ok: true, discovered: 2, createdArtifacts: 2, errorCount: 0 });
    const occurrences = storedOccurrences();
    expect(occurrences.map((o) => o.path)).toEqual(['.agents/skills/loop', 'AGENTS.md']);
    expect(occurrences[0]?.parsedMetadata).toMatchObject({
      frontmatter: {},
      warnings: expect.arrayContaining([
        'Invalid frontmatter: frontmatter cannot be stored as JSON: it contains an alias that refers to itself under the key "metadata"',
      ]) as unknown,
    });
    expect(occurrences[1]?.parsedMetadata).toMatchObject({ warnings: [] });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      syncStatus: 'ok',
      syncError: null,
    });
  });

  it('stores nothing when the runner shuts down while the results wait behind another transaction', async () => {
    const project = join(sources, 'project');
    write(project, { 'AGENTS.md': '# Project rules\n' });
    const repository = await register(project, 'local-directory');
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    const runner = createRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: Promise<void> | undefined;
    let stopped: Promise<void> | undefined;
    // Another job's transaction holds the connection when discovery ends, so the scan's apply
    // transaction queues behind it (the scan's own abort check has passed by then). Once it is
    // queued, the runner shuts down; the other transaction ends only after the abort.
    discoveryHooks.afterDiscovery = (signal) => {
      holding = withTransaction(handle, () => gate);
      signal?.addEventListener('abort', () => release());
      setImmediate(() => {
        stopped = runner.stop();
      });
    };

    const [execution] = await runner.runUntilIdle();
    await holding;
    await stopped;
    expect(execution).toMatchObject({ jobId: job.id, status: 'interrupted', error: null });
    expect((await getJob(handle.db, job.id))?.status).toBe('interrupted');
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
    expect(await handle.db.$count(schema.artifactOccurrences)).toBe(0);
    expect((await getRepository(handle.db, repository.id))?.lastSyncAt).toBeNull();
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
    expect(await getJob(handle.db, 'job_bundled')).toMatchObject({
      status: 'failed',
      result: { ok: false, code: 'unsupported-provider' },
    });
    expect(await getJob(handle.db, 'job_missing')).toMatchObject({
      status: 'failed',
      error: 'The repository no longer exists.',
      result: {
        ok: false,
        code: 'repository-not-found',
        message: 'The repository no longer exists.',
      },
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
