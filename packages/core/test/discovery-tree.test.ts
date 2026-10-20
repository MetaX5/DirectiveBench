import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DiscoveryLimitError,
  discoverArtifacts,
  discoverArtifactsInTree,
  selectCandidateFiles,
  type RepositoryTreeEntry,
} from '../src/discovery';
import { buildDiscoveryFixture, SKILL } from './discovery-fixture';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'db-discovery-tree-'));
  outside = await mkdtemp(join(tmpdir(), 'db-discovery-tree-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Lists a directory the way `git ls-tree -r` lists a commit: every file and symlink, unsorted. */
async function listTree(dir: string, prefix = ''): Promise<RepositoryTreeEntry[]> {
  const entries: RepositoryTreeEntry[] = [];
  for (const name of (await readdir(dir)).reverse()) {
    const abs = join(dir, name);
    const path = prefix ? `${prefix}/${name}` : name;
    const stats = await lstat(abs);
    if (stats.isSymbolicLink()) entries.push({ path, kind: 'symlink' });
    else if (stats.isDirectory()) entries.push(...(await listTree(abs, path)));
    else entries.push({ path, kind: 'file' });
  }
  return entries;
}

/** The contents the hosted scan hands over: the selected files' bytes, read from the disk. */
async function contentsOf(paths: readonly string[]): Promise<Map<string, Buffer | number>> {
  const contents = new Map<string, Buffer | number>();
  for (const path of paths) contents.set(path, await readFile(join(root, path)));
  return contents;
}

const only = (entries: Record<string, Buffer | number>) => new Map(Object.entries(entries));

const bytes = (text: string) => Buffer.from(text);

describe('discoverArtifactsInTree', () => {
  it('finds exactly what discoverArtifacts finds on disk, reading only the selected files', async () => {
    await buildDiscoveryFixture(root, outside);
    const entries = await listTree(root);
    const selected = selectCandidateFiles(entries);
    const fromTree = await discoverArtifactsInTree(entries, await contentsOf(selected));
    expect(fromTree).toEqual(await discoverArtifacts(root));
    expect(selected).not.toContain('.git/AGENTS.md');
    expect(selected).not.toContain('node_modules/pkg/SKILL.md');
    expect(selected).not.toContain('README.md');
    expect(selected).not.toContain('.agents/skills/validate/link.md');
    expect(selected).toContain('.agents/skills/validate/assets/logo.png');
    expect(selected).toContain('.agents/skills/validate/nested/extra.md');
  });

  it('keeps a file named like a skipped directory and drops files below one at any depth', () => {
    const entries: RepositoryTreeEntry[] = [
      { path: 'node_modules', kind: 'file' },
      { path: 'a/node_modules/x/AGENTS.md', kind: 'file' },
      { path: 'a/.git/AGENTS.md', kind: 'file' },
      { path: 'a/AGENTS.md', kind: 'file' },
    ];
    expect(selectCandidateFiles(entries)).toEqual(['a/AGENTS.md']);
  });

  it('does not select the files of a skill above the file limit, nor a symlinked candidate', async () => {
    const entries: RepositoryTreeEntry[] = [
      { path: 'big/SKILL.md', kind: 'file' },
      { path: 'big/a.md', kind: 'file' },
      { path: 'big/b.md', kind: 'file' },
      { path: 'small/SKILL.md', kind: 'file' },
      { path: 'CLAUDE.md', kind: 'symlink' },
    ];
    const limits = { maxFilesPerArtifact: 2 };
    expect(selectCandidateFiles(entries, { limits })).toEqual(['small/SKILL.md']);
    const result = await discoverArtifactsInTree(
      entries,
      only({ 'small/SKILL.md': bytes(SKILL) }),
      {
        limits,
      },
    );
    expect(result.artifacts.map((artifact) => artifact.occurrencePath)).toEqual(['small']);
    expect(result.errors.map((error) => [error.path, error.code])).toEqual([
      ['CLAUDE.md', 'symlink'],
      ['big/SKILL.md', 'too-many-files'],
    ]);
  });

  it('aborts before reading when there are too many candidates', async () => {
    const entries: RepositoryTreeEntry[] = [
      { path: 'a/AGENTS.md', kind: 'file' },
      { path: 'b/AGENTS.md', kind: 'file' },
    ];
    const limits = { maxCandidatesPerScan: 1 };
    expect(() => selectCandidateFiles(entries, { limits })).toThrow(DiscoveryLimitError);
    await expect(discoverArtifactsInTree(entries, new Map(), { limits })).rejects.toThrow(
      DiscoveryLimitError,
    );
  });

  it('reports a file above its limit as too large, whether given by size or by bytes', async () => {
    const entries: RepositoryTreeEntry[] = [
      { path: 'AGENTS.md', kind: 'file' },
      { path: 'CLAUDE.md', kind: 'file' },
    ];
    const limits = { maxPrimaryFileBytes: 3 };
    const result = await discoverArtifactsInTree(
      entries,
      only({ 'AGENTS.md': 10, 'CLAUDE.md': bytes('four') }),
      { limits },
    );
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([
      {
        path: 'AGENTS.md',
        code: 'too-large',
        message: 'AGENTS.md is 10 bytes, larger than the limit of 3 bytes',
      },
      {
        path: 'CLAUDE.md',
        code: 'too-large',
        message: 'CLAUDE.md is 4 bytes, larger than the limit of 3 bytes',
      },
    ]);
  });

  it('fails the whole discovery for a file whose content was not provided', async () => {
    const entries: RepositoryTreeEntry[] = [{ path: 'AGENTS.md', kind: 'file' }];
    await expect(discoverArtifactsInTree(entries, new Map())).rejects.toThrow(
      'The content of AGENTS.md was not provided',
    );
    await expect(discoverArtifactsInTree(entries, only({ 'AGENTS.md': 5 }))).rejects.toThrow(
      'The content of AGENTS.md was not provided',
    );
  });

  it('stops at an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      discoverArtifactsInTree([{ path: 'AGENTS.md', kind: 'file' }], only({}), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop');
  });

  it.each(['../AGENTS.md', 'a/../AGENTS.md', './AGENTS.md', '/AGENTS.md', 'a//AGENTS.md', ''])(
    'rejects the unnormalised tree path %j',
    async (path) => {
      const entries: RepositoryTreeEntry[] = [{ path, kind: 'file' }];
      expect(() => selectCandidateFiles(entries)).toThrow('not normalised');
      await expect(discoverArtifactsInTree(entries, new Map())).rejects.toThrow('not normalised');
    },
  );
});
