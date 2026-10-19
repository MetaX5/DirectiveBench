import { renameSync, symlinkSync, type Dirent } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Artifacts from '../src/artifacts';
import { discoverArtifacts } from '../src/discovery';
import { buildDiscoveryFixture } from './discovery-fixture';

/**
 * Behaviour the real filesystem does not produce on demand: directory listings in an order other
 * than the one the platform returns, a file that cannot be opened, and an unexpected parser
 * failure. Hooks wrap the real modules; without a hook every call goes to the real implementation.
 */
const hooks = vi.hoisted(() => ({
  reorderEntries: null as ((entries: Dirent[]) => Dirent[]) | null,
  failOpen: null as ((path: string) => Error | null) | null,
  failParse: false,
  /** Runs after a directory was listed, before the walk descends into its entries. */
  afterList: null as ((path: string) => void) | null,
  /** Runs before a primary file is parsed, i.e. after the walk and before supporting reads. */
  beforeParse: null as ((relPath: string) => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readdir: async (path: string, options: { withFileTypes: true }) => {
      const entries = await actual.readdir(path, options);
      hooks.afterList?.(path);
      return hooks.reorderEntries ? hooks.reorderEntries(entries) : entries;
    },
    open: async (path: string, flags: number) => {
      const failure = hooks.failOpen?.(path);
      if (failure) throw failure;
      return actual.open(path, flags);
    },
  };
});

vi.mock('../src/artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof Artifacts>();
  return {
    ...actual,
    parseArtifactFile: (relPath: string, content: string) => {
      if (hooks.failParse) throw new TypeError('unexpected parser failure');
      hooks.beforeParse?.(relPath);
      return actual.parseArtifactFile(relPath, content);
    },
  };
});

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'db-discovery-sim-'));
  outside = await mkdtemp(join(tmpdir(), 'db-discovery-sim-outside-'));
  await buildDiscoveryFixture(root, outside);
});

afterEach(async () => {
  hooks.reorderEntries = null;
  hooks.failOpen = null;
  hooks.failParse = false;
  hooks.afterList = null;
  hooks.beforeParse = null;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Deterministic permutation (seeded linear congruential shuffle). */
function shuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

describe('discoverArtifacts with simulated filesystem behaviour', () => {
  it('returns the same result for any directory listing order', async () => {
    const baseline = await discoverArtifacts(root);
    hooks.reorderEntries = (entries) => [...entries].reverse();
    expect(await discoverArtifacts(root)).toEqual(baseline);
    for (const seed of [1, 7, 42]) {
      hooks.reorderEntries = (entries) => shuffle(entries, seed);
      expect(await discoverArtifacts(root)).toEqual(baseline);
    }
  });

  it('reports a file that cannot be read as an error for its artifact only', async () => {
    // The message names the relative path and the error code, never the absolute path.
    hooks.failOpen = (path) =>
      path.endsWith('references/api.md')
        ? Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })
        : null;
    const result = await discoverArtifacts(root);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContain(
      '.agents/skills/validate/SKILL.md',
    );
    expect(result.artifacts).toHaveLength(9);
    expect(result.errors).toEqual([
      {
        path: '.agents/skills/validate/SKILL.md',
        code: 'read-failed',
        message: 'Cannot read .agents/skills/validate/references/api.md (EACCES)',
      },
      expect.objectContaining({ path: 'linked/CLAUDE.md', code: 'symlink' }),
    ]);

    hooks.failOpen = (path) => (path.endsWith('AGENTS.md') ? new Error(`no code: ${path}`) : null);
    const uncoded = await discoverArtifacts(root);
    expect(uncoded.errors).toContainEqual({
      path: 'AGENTS.md',
      code: 'read-failed',
      message: 'Cannot read AGENTS.md (unknown error)',
    });
  });

  // A directory replaced by a symlink while the scan runs must not redirect it outside the root.
  function swapForSymlink(dir: string, target: string): void {
    renameSync(dir, target);
    symlinkSync(target, dir);
  }

  it('does not enter a directory that was swapped for a symlink after its parent was listed', async () => {
    const skills = join(root, '.agents/skills');
    hooks.afterList = (path) => {
      if (path.endsWith('/.agents/skills')) {
        hooks.afterList = null;
        swapForSymlink(join(skills, 'validate'), join(outside, 'validate-moved'));
      }
    };
    const result = await discoverArtifacts(root);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContainEqual(
      expect.stringMatching(/^\.agents\/skills\/validate/),
    );
    expect(result.errors).toContainEqual({
      path: '.agents/skills/validate',
      code: 'read-failed',
      message:
        'Directory .agents/skills/validate changed during the scan and no longer resolves inside the scanned root; its files were not scanned',
    });
  });

  it('does not read through a directory that was swapped for a symlink after the walk', async () => {
    const references = join(root, '.agents/skills/validate/references');
    hooks.beforeParse = (relPath) => {
      if (relPath === '.agents/skills/validate/SKILL.md') {
        hooks.beforeParse = null;
        swapForSymlink(references, join(outside, 'references-moved'));
      }
    };
    const result = await discoverArtifacts(root);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContain(
      '.agents/skills/validate/SKILL.md',
    );
    expect(result.errors).toContainEqual({
      path: '.agents/skills/validate/SKILL.md',
      code: 'read-failed',
      message:
        'Cannot read .agents/skills/validate/references/api.md: its directory changed during the scan and no longer resolves inside the scanned root',
    });
  });

  it('does not swallow unexpected errors', async () => {
    hooks.failParse = true;
    await expect(discoverArtifacts(root)).rejects.toThrow('unexpected parser failure');
  });
});
