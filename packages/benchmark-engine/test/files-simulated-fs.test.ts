import { mkdirSync, readdirSync, writeFileSync, type Dirent } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildManifest, snapshotDirectory } from '../src/files';
import { useTempDirs } from './helpers';

/**
 * Filesystem behaviour that cannot be produced reliably on the test machine: a concurrent import
 * winning the race to the atomic rename, a failing rename, and a directory listing order other
 * than the one libuv returns on Linux. Hooks wrap the real `node:fs/promises`; without a hook
 * every call goes to the real filesystem.
 */
const hooks = vi.hoisted(() => ({
  beforeRename: null as ((from: string, to: string) => Promise<void>) | null,
  reorderEntries: null as ((entries: Dirent[]) => Dirent[]) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(from, to);
      return actual.rename(from, to);
    },
    readdir: async (path: string, options: { withFileTypes: true }) => {
      const entries = await actual.readdir(path, options);
      return hooks.reorderEntries ? hooks.reorderEntries(entries) : entries;
    },
  };
});

const tmp = useTempDirs();

function fixture(): string {
  const dir = tmp('fixture');
  writeFileSync(join(dir, 'a.txt'), 'content');
  return dir;
}

afterEach(() => {
  hooks.beforeRename = null;
  hooks.reorderEntries = null;
});

describe('buildManifest ordering', () => {
  it('orders paths by code unit regardless of the directory listing order', async () => {
    const root = tmp('order');
    for (const name of ['a.txt', 'B.txt', 'c.txt', '_.txt']) writeFileSync(join(root, name), name);
    // Case-insensitive listing order, as NTFS returns it.
    hooks.reorderEntries = (entries) =>
      [...entries].sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
    const ntfsOrder = await buildManifest(root);
    hooks.reorderEntries = (entries) => [...entries].reverse();
    const reversed = await buildManifest(root);
    hooks.reorderEntries = null;
    const native = await buildManifest(root);
    expect(native.map((f) => f.path)).toEqual(['B.txt', '_.txt', 'a.txt', 'c.txt']);
    expect(ntfsOrder).toEqual(native);
    expect(reversed).toEqual(native);
  });
});

describe('snapshotDirectory under concurrent imports', () => {
  it('returns the snapshot another import stored first and removes its own temporary copy', async () => {
    const store = tmp('store');
    hooks.beforeRename = async (_from, to) => {
      // Another process finishes storing the identical snapshot first.
      mkdirSync(to);
      writeFileSync(join(to, 'a.txt'), 'content');
    };
    const snapshot = await snapshotDirectory(fixture(), store);
    expect(snapshot).toMatchObject({ dir: join(store, snapshot.hash), fileCount: 1 });
    expect(readdirSync(store)).toEqual([snapshot.hash]);
  });

  it('rethrows other storage failures and leaves no partial snapshot behind', async () => {
    const store = tmp('store');
    hooks.beforeRename = () => Promise.reject(new Error('ENOSPC: no space left on device'));
    await expect(snapshotDirectory(fixture(), store)).rejects.toThrow('ENOSPC');
    expect(readdirSync(store)).toEqual([]);
  });
});
