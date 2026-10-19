import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import type * as Fs from 'node:fs';
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
 * than the one the platform returns, a file that cannot be opened or that is swapped around its
 * open, file systems without inodes, a platform without `O_NOFOLLOW` and `O_NONBLOCK` (Windows), and an unexpected
 * parser failure. Hooks wrap the real modules; without a hook every call goes to the real
 * implementation.
 */
const hooks = vi.hoisted(() => ({
  reorderEntries: null as ((entries: Dirent[]) => Dirent[]) | null,
  failOpen: null as ((path: string) => Error | null) | null,
  failParse: false,
  /** Runs after a directory was listed, before the walk descends into its entries. */
  afterList: null as ((path: string) => void) | null,
  /** Runs before a primary file is parsed, i.e. after the walk and before supporting reads. */
  beforeParse: null as ((relPath: string) => void) | null,
  /** Run right before and right after a file is opened for reading. */
  beforeOpen: null as ((path: string) => void) | null,
  afterOpen: null as ((path: string) => void) | null,
  /** Changes the stats of an opened handle (`fstat`) or of a path (`lstat`). */
  patchStats: null as ((stats: BigIntStats, source: 'handle' | 'path') => void) | null,
  /** Simulates Windows, where `constants.O_NOFOLLOW` and `constants.O_NONBLOCK` are undefined. */
  windowsFlags: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  // `fs.constants` is frozen, so a copy carries the switchable flag.
  const constants = { ...actual.constants };
  for (const flag of ['O_NOFOLLOW', 'O_NONBLOCK'] as const) {
    Object.defineProperty(constants, flag, {
      get: () => (hooks.windowsFlags ? undefined : actual.constants[flag]),
    });
  }
  return { ...actual, constants };
});

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
      hooks.beforeOpen?.(path);
      const handle = await actual.open(path, flags);
      hooks.afterOpen?.(path);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (options: { bigint: true }) => {
        const stats = await stat(options);
        hooks.patchStats?.(stats, 'handle');
        return stats;
      }) as typeof handle.stat;
      return handle;
    },
    lstat: async (path: string, options: { bigint: true }) => {
      const stats = await actual.lstat(path, options);
      hooks.patchStats?.(stats, 'path');
      return stats;
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
  hooks.beforeOpen = null;
  hooks.afterOpen = null;
  hooks.patchStats = null;
  hooks.windowsFlags = false;
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

  it('reports a skill whose inner directory was swapped during the walk as one error', async () => {
    hooks.afterList = (path) => {
      if (path.endsWith('/.agents/skills/validate')) {
        hooks.afterList = null;
        swapForSymlink(join(path, 'references'), join(outside, 'references-moved'));
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
        'Skill .agents/skills/validate/SKILL.md is incomplete and was not discovered. Directory .agents/skills/validate/references changed during the scan and no longer resolves inside the scanned root; its files were not scanned',
    });
    expect(result.errors.map((error) => error.path)).not.toContain(
      '.agents/skills/validate/references',
    );
  });

  const API = '.agents/skills/validate/references/api.md';
  const swapped = {
    path: '.agents/skills/validate/SKILL.md',
    code: 'read-failed',
    message: `Cannot read ${API}: it changed during the scan and is no longer the regular file the walk found`,
  };

  /** Runs `swap` once, for the open of `api.md`, at the given moment. */
  function onApiOpen(moment: 'beforeOpen' | 'afterOpen', swap: (abs: string) => void): void {
    hooks[moment] = (path) => {
      if (path.endsWith(API)) {
        hooks[moment] = null;
        swap(path);
      }
    };
  }

  it('rejects a file that became a symlink between the open and the identity check', async () => {
    onApiOpen('afterOpen', (abs) => {
      renameSync(abs, join(outside, 'api-moved.md'));
      symlinkSync(join(outside, 'secret.md'), abs);
    });
    const result = await discoverArtifacts(root);
    expect(result.errors).toContainEqual(swapped);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContain(swapped.path);
  });

  it('rejects a file that became a directory before the open', async () => {
    onApiOpen('beforeOpen', (abs) => {
      renameSync(abs, join(outside, 'api-moved.md'));
      mkdirSync(abs);
    });
    expect((await discoverArtifacts(root)).errors).toContainEqual(swapped);
  });

  it('rejects a handle whose device or inode differs from the path, or a path that is a symlink', async () => {
    const patches: ((stats: BigIntStats, source: 'handle' | 'path') => void)[] = [
      (stats, source) => {
        if (source === 'handle') stats.ino += 1n;
      },
      (stats, source) => {
        if (source === 'handle') stats.dev += 1n;
      },
      // Defence in depth: a path reported as a symlink with its target's device and inode.
      (stats, source) => {
        if (source === 'path') stats.isSymbolicLink = () => true;
      },
    ];
    for (const patch of patches) {
      hooks.patchStats = patch;
      const result = await discoverArtifacts(root);
      // Every read fails closed, so not even a single-file artifact is discovered.
      expect(result.artifacts).toEqual([]);
      expect(result.errors).toContainEqual({
        path: 'AGENTS.md',
        code: 'read-failed',
        message:
          'Cannot read AGENTS.md: it changed during the scan and is no longer the regular file the walk found',
      });
    }
  });

  it('fails closed on a file system without a usable file ID', async () => {
    // 0: no inodes; all ones: an invalid or unknown ReFS file ID (Windows). Equal on both sides.
    for (const ino of [0n, 0xffff_ffff_ffff_ffffn]) {
      hooks.patchStats = (stats) => {
        stats.ino = ino;
      };
      const result = await discoverArtifacts(root);
      expect(result.artifacts).toEqual([]);
      expect(result.errors).toContainEqual({
        path: 'AGENTS.md',
        code: 'read-failed',
        message: 'Cannot read AGENTS.md: its file identity cannot be verified on this file system',
      });
    }
  });

  it.runIf(process.platform === 'linux')(
    'refuses in the open itself a file swapped for a symlink before the open (O_NOFOLLOW)',
    async () => {
      onApiOpen('beforeOpen', (abs) => {
        renameSync(abs, join(outside, 'api-moved.md'));
        symlinkSync(join(outside, 'secret.md'), abs);
      });
      const result = await discoverArtifacts(root);
      expect(result.errors).toContainEqual({
        path: swapped.path,
        code: 'read-failed',
        message: `Cannot read ${API} (ELOOP)`,
      });
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContain(swapped.path);
    },
  );

  it.runIf(process.platform === 'linux')(
    'does not block on a file swapped for a FIFO before the open (O_NONBLOCK)',
    async () => {
      // Without O_NONBLOCK the open would wait for a writer forever and the test would time out.
      onApiOpen('beforeOpen', (abs) => {
        renameSync(abs, join(outside, 'api-moved.md'));
        execFileSync('mkfifo', [abs]);
      });
      const result = await discoverArtifacts(root);
      expect(result.errors).toContainEqual(swapped);
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).not.toContain(swapped.path);
    },
    // A blocked open would hold a thread-pool thread: fail fast and clearly instead.
    2_000,
  );

  describe('on a platform without O_NOFOLLOW and O_NONBLOCK (Windows)', () => {
    beforeEach(() => {
      hooks.windowsFlags = true;
    });

    it('reads unchanged files as usual', async () => {
      hooks.windowsFlags = false;
      const baseline = await discoverArtifacts(root);
      hooks.windowsFlags = true;
      expect(await discoverArtifacts(root)).toEqual(baseline);
    });

    it('rejects a file swapped for a symlink before the open, which the open follows', async () => {
      onApiOpen('beforeOpen', (abs) => {
        renameSync(abs, join(outside, 'api-moved.md'));
        symlinkSync(join(outside, 'secret.md'), abs);
      });
      const result = await discoverArtifacts(root);
      expect(result.errors).toContainEqual(swapped);
      expect(JSON.stringify(result.artifacts)).not.toContain('outside the root');
    });

    it('rejects a symlink swapped back to the original file right after the open', async () => {
      // The path is a regular file again when it is checked, but the handle is the link target.
      const stash = join(outside, 'api-stash.md');
      onApiOpen('beforeOpen', (abs) => {
        renameSync(abs, stash);
        symlinkSync(join(outside, 'secret.md'), abs);
        onApiOpen('afterOpen', () => {
          unlinkSync(abs);
          renameSync(stash, abs);
        });
      });
      const result = await discoverArtifacts(root);
      expect(result.errors).toContainEqual(swapped);
      expect(JSON.stringify(result.artifacts)).not.toContain('outside the root');
    });
  });

  it('does not swallow unexpected errors', async () => {
    hooks.failParse = true;
    await expect(discoverArtifacts(root)).rejects.toThrow('unexpected parser failure');
  });
});
