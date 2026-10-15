import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashManifest } from '@directivebench/core';
import {
  UnsafeFileError,
  buildManifest,
  copyTree,
  diffManifests,
  snapshotDirectory,
} from '../src/files';
import { prepareSuiteImport, suiteContentHash } from '../src/import';
import { useTempDirs } from './helpers';

const tmp = useTempDirs();
const posixOnly = it.skipIf(process.platform === 'win32');

function tree(files: Record<string, string>): string {
  const root = tmp('tree');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('buildManifest', () => {
  it('lists regular files sorted by path with sizes and hashes', async () => {
    const root = tree({ 'b.txt': 'bb', 'a/z.txt': 'z', 'a/c.txt': 'ccc', 'd.txt': '' });
    const manifest = await buildManifest(root);
    expect(manifest.map((f) => [f.path, f.size])).toEqual([
      ['a/c.txt', 3],
      ['a/z.txt', 1],
      ['b.txt', 2],
      ['d.txt', 0],
    ]);
    expect(manifest[0]?.sha256).toBe(
      // sha256("ccc")
      '64daa44ad493ff28a96effab6e77f1732a3d97d83241581b37dbd70a7a4900fe',
    );
  });

  it('skips ignored paths, including whole directories', async () => {
    const root = tree({ 'keep.txt': '1', 'node_modules/x/index.js': '1', 'skip.log': '1' });
    const manifest = await buildManifest(root, {
      ignore: (rel) => rel === 'node_modules' || rel.endsWith('.log'),
    });
    expect(manifest.map((f) => f.path)).toEqual(['keep.txt']);
  });

  it('enforces the file count and total size limits', async () => {
    const root = tree({ a: '12345', b: '12345', c: '12345' });
    await expect(
      buildManifest(root, { limits: { maxFiles: 2, maxTotalBytes: 100 } }),
    ).rejects.toThrow(new UnsafeFileError(`More than 2 files in ${root}`));
    await expect(
      buildManifest(root, { limits: { maxFiles: 10, maxTotalBytes: 12 } }),
    ).rejects.toThrow(`More than 12 bytes in ${root}`);
    expect(await buildManifest(root, { limits: { maxFiles: 3, maxTotalBytes: 15 } })).toHaveLength(
      3,
    );
  });

  posixOnly('rejects symbolic links, even to files inside the root', async () => {
    const root = tree({ 'real.txt': 'x' });
    symlinkSync('real.txt', join(root, 'inner-link'));
    const error = await buildManifest(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeFileError);
    expect((error as Error).message).toBe('Symbolic links are not allowed: inner-link');
  });

  posixOnly('rejects symlinked directories that point outside the root', async () => {
    const outside = tree({ 'secret.txt': 'secret' });
    const root = tree({ 'a.txt': 'x' });
    symlinkSync(outside, join(root, 'escape'), 'dir');
    await expect(buildManifest(root)).rejects.toThrow('Symbolic links are not allowed: escape');
  });

  posixOnly('rejects special files such as named pipes', async () => {
    const root = tree({ 'a.txt': 'x' });
    execFileSync('mkfifo', [join(root, 'pipe')]);
    await expect(buildManifest(root)).rejects.toThrow(
      new UnsafeFileError('Unsupported file type: pipe'),
    );
  });
});

describe('copyTree', () => {
  it('copies nested files byte for byte', async () => {
    const source = tree({ 'a/b/c.txt': 'deep', 'top.txt': 'top' });
    const destination = join(tmp('copy'), 'out');
    await copyTree(source, destination);
    expect(readFileSync(join(destination, 'a/b/c.txt'), 'utf8')).toBe('deep');
    expect(hashManifest(await buildManifest(destination))).toBe(
      hashManifest(await buildManifest(source)),
    );
  });

  posixOnly('refuses to copy a tree containing a symlink and copies nothing', async () => {
    const source = tree({ 'a.txt': 'x' });
    symlinkSync('/etc/passwd', join(source, 'passwd'));
    const destination = join(tmp('copy'), 'out');
    await expect(copyTree(source, destination)).rejects.toThrow(UnsafeFileError);
    expect(() => readdirSync(destination)).toThrow(/ENOENT/);
  });
});

describe('snapshotDirectory', () => {
  it('rejects missing, non-directory and empty fixture sources', async () => {
    const store = tmp('store');
    const missing = join(tmp('src'), 'missing');
    await expect(snapshotDirectory(missing, store)).rejects.toThrow(
      `Fixture directory not found: ${missing}`,
    );
    const file = join(tree({ 'f.txt': 'x' }), 'f.txt');
    await expect(snapshotDirectory(file, store)).rejects.toThrow(
      `Fixture directory not found: ${file}`,
    );
    const empty = tmp('empty');
    await expect(snapshotDirectory(empty, store)).rejects.toThrow(
      `Fixture directory is empty: ${empty}`,
    );
    expect(readdirSync(store)).toEqual([]);
  });

  it('stores identical content once under its hash, independent of the source location', async () => {
    const store = join(tmp('store'), 'nested');
    const first = await snapshotDirectory(tree({ 'a.txt': 'same', 'b/c.txt': 'x' }), store);
    const second = await snapshotDirectory(tree({ 'a.txt': 'same', 'b/c.txt': 'x' }), store);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ fileCount: 2, totalBytes: 5, dir: join(store, first.hash) });
    // No temporary directories are left behind.
    expect(readdirSync(store)).toEqual([first.hash]);
    expect(hashManifest(await buildManifest(first.dir))).toBe(first.hash);
  });
});

describe('diffManifests', () => {
  it('reports added, modified and deleted files sorted by path', () => {
    const before = [
      { path: 'z-deleted', sha256: '1' },
      { path: 'm-same', sha256: '1' },
      { path: 'b-modified', sha256: '1' },
      { path: 'a-deleted', sha256: '1' },
    ];
    const after = [
      { path: 'y-added', sha256: '1' },
      { path: 'm-same', sha256: '1' },
      { path: 'b-modified', sha256: '2' },
      { path: 'c-added', sha256: '1' },
    ];
    expect(diffManifests(before, after)).toEqual([
      { path: 'a-deleted', change: 'deleted' },
      { path: 'b-modified', change: 'modified' },
      { path: 'c-added', change: 'added' },
      { path: 'y-added', change: 'added' },
      { path: 'z-deleted', change: 'deleted' },
    ]);
    expect(diffManifests(after, after)).toEqual([]);
  });
});

describe('prepareSuiteImport', () => {
  it('snapshots fixtures of cases without a verification overlay', async () => {
    const root = tree({
      'suite/fixture/README.md': 'hello',
      'suite/benchmark.json': JSON.stringify({
        schemaVersion: 1,
        id: 'suite',
        name: 'Suite',
        execution: { agent: 'mock' },
        cases: [
          {
            id: 'c',
            name: 'C',
            prompt: 'p',
            fixture: { path: 'fixture' },
            assertions: [{ id: 'a', type: 'file-exists', path: 'README.md' }],
          },
        ],
      }),
    });
    const store = tmp('store');
    const prepared = await prepareSuiteImport(join(root, 'suite/benchmark.json'), store);
    const fixtureHash = prepared.snapshots[0]?.hash as string;
    expect(prepared.fixtures).toEqual({ c: { fixture: fixtureHash } });
    expect(prepared.snapshots).toEqual([
      expect.objectContaining({ sourcePath: join(root, 'suite/fixture'), fileCount: 1 }),
    ]);
    expect(prepared.contentHash).toBe(suiteContentHash(prepared.definition, prepared.fixtures));
    expect(readFileSync(join(store, fixtureHash, 'README.md'), 'utf8')).toBe('hello');
  });
});
