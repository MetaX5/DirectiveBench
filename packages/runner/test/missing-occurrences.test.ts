import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
import {
  enqueueRepositoryScanJob,
  getRepositoryScan,
  MAX_REPORTED_SCAN_ERRORS,
  migrateDatabase,
  openDatabase,
  registerLocalRepository,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner } from '../src/index';

// SPEC-125 Phase 1 through real local scans: a deleted file goes missing, comes back when restored,
// an empty scan marks nothing (A7), and no failed or partial scan marks anything (AC-4).

// Discovery stays real; a test can lower its limits or act once it has finished.
const hooks = vi.hoisted(() => ({
  limits: undefined as Partial<core.DiscoveryLimits> | undefined,
  afterDiscovery: null as (() => void) | null,
}));
vi.mock('@directivebench/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return {
    ...actual,
    discoverArtifacts: async (root: string, options?: core.DiscoveryOptions) => {
      const result = await actual.discoverArtifacts(root, { ...options, limits: hooks.limits });
      hooks.afterDiscovery?.();
      return result;
    },
  };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const SKILL = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\n# ${name}\n`;

let handle: DatabaseHandle;
let dataDir: string;
let sources: string;
let locked: string[];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-missing-data-'));
  sources = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-missing-sources-')));
  locked = [];
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  hooks.limits = undefined;
  hooks.afterDiscovery = null;
  handle.close();
  for (const dir of locked) chmodSync(dir, 0o755);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sources, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
}

function lock(dir: string): void {
  chmodSync(dir, 0o000);
  locked.push(dir);
}

/** A repository with a rule file and two skills, so deleting one leaves artifacts (A7). */
function buildRepository(name = 'skills'): string {
  const repo = join(sources, name);
  write(repo, {
    'AGENTS.md': '# Rules\n',
    'skills/review/SKILL.md': SKILL('review'),
    'skills/deploy/SKILL.md': SKILL('deploy'),
  });
  return repo;
}

async function register(location: string, provider: 'local-git' | 'local-directory') {
  const outcome = await registerLocalRepository(
    handle,
    { provider, name: 'skills', location, defaultBranch: null },
    { homeDirectory: join(sources, 'home'), confirmedLocation: location },
  );
  if (outcome.status !== 'registered') throw new Error('not registered');
  return outcome.repository.id;
}

function runner() {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    cacheDir: join(dataDir, 'cache'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
  });
}

async function scan(repositoryId: string) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  const [execution] = await runner().runUntilIdle();
  const result = (await getRepositoryScan(handle.db, job.id))?.result ?? null;
  return { execution, result };
}

function statuses(): string[][] {
  return handle.sqlite
    .prepare('select path, status from artifact_occurrences order by path')
    .all()
    .map((row) => [String(row.path), String(row.status)]);
}

const ALL_ACTIVE = [
  ['AGENTS.md', 'active'],
  ['skills/deploy', 'active'],
  ['skills/review', 'active'],
];

describe('local scans mark missing occurrences (SPEC-125)', () => {
  it.each(['local-directory', 'local-git'] as const)(
    '%s: a deleted skill goes missing, comes back when restored, and an empty scan keeps all',
    async (provider) => {
      const repo = buildRepository();
      if (provider === 'local-git') {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: FIXTURE_GIT_ENV });
      }
      const id = await register(repo, provider);
      expect((await scan(id)).result).toMatchObject({ ok: true, discovered: 3 });

      const parked = join(sources, 'parked');
      renameSync(join(repo, 'skills/review'), parked);
      expect((await scan(id)).result).toMatchObject({
        ok: true,
        removedOccurrences: 1,
        reactivatedOccurrences: 0,
        emptyScanKeptOccurrences: 0,
      });
      expect(statuses()).toEqual([
        ['AGENTS.md', 'active'],
        ['skills/deploy', 'active'],
        ['skills/review', 'removed'],
      ]);

      renameSync(parked, join(repo, 'skills/review'));
      expect((await scan(id)).result).toMatchObject({
        ok: true,
        createdVersions: 0,
        reactivatedOccurrences: 1,
        removedOccurrences: 0,
      });
      expect(statuses()).toEqual(ALL_ACTIVE);

      // Every artifact deleted (or the directory emptied): nothing marked, the count reported.
      rmSync(join(repo, 'skills'), { recursive: true });
      rmSync(join(repo, 'AGENTS.md'));
      expect((await scan(id)).result).toMatchObject({
        ok: true,
        discovered: 0,
        removedOccurrences: 0,
        emptyScanKeptOccurrences: 3,
      });
      expect(statuses()).toEqual(ALL_ACTIVE);
    },
  );

  it('follows a local-git branch switch: missing on the other branch, active after switching back', async () => {
    const repo = buildRepository();
    const gitIn = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', ...args], {
        cwd: repo,
        env: FIXTURE_GIT_ENV,
      });
    gitIn('init', '-q', '-b', 'main');
    gitIn('add', '-A');
    gitIn('commit', '-q', '-m', 'all');
    gitIn('checkout', '-q', '-b', 'slim');
    gitIn('rm', '-q', '-r', 'skills/review');
    gitIn('commit', '-q', '-m', 'slim');
    gitIn('checkout', '-q', 'main');
    const id = await register(repo, 'local-git');
    await scan(id);
    gitIn('checkout', '-q', 'slim');
    expect((await scan(id)).result).toMatchObject({ ok: true, removedOccurrences: 1 });
    gitIn('checkout', '-q', 'main');
    expect((await scan(id)).result).toMatchObject({ ok: true, reactivatedOccurrences: 1 });
    expect(statuses()).toEqual(ALL_ACTIVE);
  });
});

describe('scans that fail or cannot observe a path mark nothing (SPEC-125 AC-4)', () => {
  async function scannedOnce() {
    const repo = buildRepository();
    const id = await register(repo, 'local-directory');
    await scan(id);
    // Deleted: any scan that completed would now mark it missing.
    rmSync(join(repo, 'skills/review'), { recursive: true });
    return { repo, id };
  }

  it('keeps everything when the location is gone or was replaced by a symlink', async () => {
    const { repo, id } = await scannedOnce();
    renameSync(repo, `${repo}-moved`);
    expect((await scan(id)).result).toMatchObject({ ok: false, code: 'path-not-found' });
    symlinkSync(`${repo}-moved`, repo);
    expect((await scan(id)).result).toMatchObject({ ok: false, code: 'location-changed' });
    expect(statuses()).toEqual(ALL_ACTIVE);
  });

  it('keeps everything when a per-scan limit aborts the scan', async () => {
    const { id } = await scannedOnce();
    hooks.limits = { maxCandidatesPerScan: 1 };
    expect((await scan(id)).result).toMatchObject({ ok: false, code: 'scan-failed' });
    hooks.limits = { maxScanBytes: 1 };
    expect((await scan(id)).result).toMatchObject({ ok: false, code: 'scan-failed' });
    expect(statuses()).toEqual(ALL_ACTIVE);
  });

  it('keeps everything when the scan is cancelled after discovery', async () => {
    const { id } = await scannedOnce();
    hooks.afterDiscovery = () => {
      handle.sqlite.exec(
        `update jobs set cancel_requested_at = '2026-01-01' where status = 'running'`,
      );
    };
    expect((await scan(id)).execution).toMatchObject({ status: 'cancelled' });
    expect(statuses()).toEqual(ALL_ACTIVE);
  });

  it('keeps occurrences below an unreadable directory, outside and inside a skill', async () => {
    const repo = join(sources, 'nested');
    write(repo, {
      'AGENTS.md': '# Rules\n',
      'docs/CLAUDE.md': '# Docs\n',
      'skills/outer/SKILL.md': SKILL('outer'),
      'skills/outer/refs/inner/SKILL.md': SKILL('inner'),
      'skills/gone/SKILL.md': SKILL('gone'),
    });
    const id = await register(repo, 'local-directory');
    expect((await scan(id)).result).toMatchObject({ ok: true, discovered: 5 });
    rmSync(join(repo, 'skills/gone'), { recursive: true });
    lock(join(repo, 'docs'));
    // Inside the outer skill: its refs/ cannot be listed, so `outer` fails (folded into its error)
    // and the nested `inner` below it is not seen either.
    lock(join(repo, 'skills/outer/refs'));
    expect((await scan(id)).result).toMatchObject({ ok: true, removedOccurrences: 1 });
    expect(statuses()).toEqual([
      ['AGENTS.md', 'active'],
      ['docs/CLAUDE.md', 'active'],
      ['skills/gone', 'removed'],
      ['skills/outer', 'active'],
      ['skills/outer/refs/inner', 'active'],
    ]);
  });

  it('keeps a skill that became too large', async () => {
    const { repo, id } = await scannedOnce();
    write(repo, { 'skills/deploy/SKILL.md': `# ${'x'.repeat(2 * 1024 * 1024)}\n` });
    const { result } = await scan(id);
    expect(result).toMatchObject({ ok: true, removedOccurrences: 1, errorCount: 1 });
    expect(statuses()).toEqual([
      ['AGENTS.md', 'active'],
      ['skills/deploy', 'active'],
      ['skills/review', 'removed'],
    ]);
  });

  it('keeps the occurrence of an error the job result no longer lists', async () => {
    const repo = join(sources, 'many');
    const count = MAX_REPORTED_SCAN_ERRORS + 1;
    const rules = Array.from(
      { length: count },
      (_, i) => `r${String(i).padStart(3, '0')}/AGENTS.md`,
    );
    write(repo, {
      'AGENTS.md': '# Rules\n',
      ...Object.fromEntries(rules.map((path) => [path, '# Rule\n'])),
    });
    const id = await register(repo, 'local-directory');
    await scan(id);
    // Every rule becomes binary: 101 errors, of which the job result keeps the first 100.
    for (const path of rules) writeFileSync(join(repo, path), Buffer.from([0, 1, 2]));
    const { result } = await scan(id);
    expect(result).toMatchObject({ ok: true, errorCount: count, removedOccurrences: 0 });
    const reported = result?.ok ? result.errors.map((error) => error.path) : [];
    expect(reported).toHaveLength(MAX_REPORTED_SCAN_ERRORS);
    const last = rules[count - 1] ?? '';
    expect(reported).not.toContain(last);
    expect(statuses()).toContainEqual([last, 'active']);
    expect(statuses().every(([, status]) => status === 'active')).toBe(true);
  });
});

describe('local scans link exact copies (SPEC-126 Phase 1)', () => {
  function occurrences(): string[][] {
    return handle.sqlite
      .prepare(
        `select r.name || ':' || o.path as place, a.slug, v.version
           from artifact_occurrences o
           join repositories r on r.id = o.repository_id
           join artifacts a on a.id = o.artifact_id
           join artifact_versions v on v.id = o.latest_version_id
          order by place`,
      )
      .all()
      .map((row) => [String(row.place), String(row.slug), String(row.version)]);
  }

  it('links a skill copied between a local-directory and a local-git repository, then follows an edit', async () => {
    const first = join(sources, 'first');
    const second = join(sources, 'second');
    write(first, { 'skills/review/SKILL.md': SKILL('review'), 'AGENTS.md': '# Rules\n' });
    write(second, { '.agents/skills/review/SKILL.md': SKILL('review'), 'AGENTS.md': '# Rules\n' });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: second, env: FIXTURE_GIT_ENV });
    const a = await registerNamed(first, 'local-directory', 'first');
    const b = await registerNamed(second, 'local-git', 'second');

    expect((await scan(a)).result).toMatchObject({ ok: true, createdArtifacts: 2 });
    expect((await scan(b)).result).toMatchObject({
      ok: true,
      discovered: 2,
      // The skill matched; the repository-level AGENTS.md never links (A3).
      createdArtifacts: 1,
      createdVersions: 1,
      linkedOccurrences: 1,
      ambiguousLinks: 0,
      movedOccurrences: 0,
      ambiguousMoves: 0,
    });
    expect(occurrences()).toEqual([
      ['first:AGENTS.md', 'agents-md', '1'],
      ['first:skills/review', 'review', '1'],
      ['second:.agents/skills/review', 'review', '1'],
      ['second:AGENTS.md', 'agents-md-2', '1'],
    ]);

    // An edit in one copy adds the next version of the shared artifact (A8).
    write(second, { '.agents/skills/review/SKILL.md': `${SKILL('review')}\nMore.\n` });
    expect((await scan(b)).result).toMatchObject({
      ok: true,
      createdVersions: 1,
      linkedOccurrences: 0,
    });
    expect(occurrences()).toContainEqual(['second:.agents/skills/review', 'review', '2']);
    expect(occurrences()).toContainEqual(['first:skills/review', 'review', '1']);
  });

  async function registerNamed(
    location: string,
    provider: 'local-git' | 'local-directory',
    name: string,
  ) {
    const outcome = await registerLocalRepository(
      handle,
      { provider, name, location, defaultBranch: null },
      { homeDirectory: join(sources, 'home'), confirmedLocation: location },
    );
    if (outcome.status !== 'registered') throw new Error('not registered');
    return outcome.repository.id;
  }
});

describe('local scans keep identity across moves (SPEC-126 Phase 3)', () => {
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

  function move(root: string, from: string, to: string): void {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
  }

  it.each(['local-git', 'local-directory'] as const)(
    'moves a skill directory and renames a rule, and leaves two identical moved skills apart (%s)',
    async (provider) => {
      const repo = join(sources, provider);
      write(repo, {
        'AGENTS.md': '# Rules\n',
        'skills/review/SKILL.md': NAMELESS('Review'),
        '.cursor/rules/no-default-export.mdc': RULE,
        'pair/x/SKILL.md': NAMELESS('Twin'),
        'pair/y/SKILL.md': NAMELESS('Twin'),
      });
      if (provider === 'local-git') {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: FIXTURE_GIT_ENV });
      }
      const id = await register(repo, provider);
      await scan(id);
      const before = rows();

      move(repo, 'skills/review', '.agents/skills/code-review');
      move(repo, '.cursor/rules/no-default-export.mdc', '.cursor/rules/no-default-exports.mdc');
      expect((await scan(id)).result).toMatchObject({
        ok: true,
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
      expect(moved.has('skills/review')).toBe(false);

      move(repo, 'pair/x', 'moved/x');
      move(repo, 'pair/y', 'moved/y');
      expect((await scan(id)).result).toMatchObject({
        ok: true,
        createdArtifacts: 2,
        movedOccurrences: 0,
        ambiguousMoves: 2,
        removedOccurrences: 2,
      });
      expect(rows().get('pair/x')?.status).toBe('removed');
    },
  );
});
