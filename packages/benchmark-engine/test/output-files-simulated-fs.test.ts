import type * as Fs from 'node:fs';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgentAdapter, pinWorkspace } from '@directivebench/agent-adapters';
import { buildManifest, diffManifests } from '../src/files';
import { captureOutputFiles } from '../src/output-files';
import { useTempDirs } from './helpers';

/**
 * File-system behaviour the test machine cannot produce on demand: a file system without file IDs,
 * a swap between the open and the identity check, a platform without `O_NOFOLLOW`/`O_NONBLOCK`
 * (Windows), and read errors or short reads in the middle of a file. Hooks wrap the real modules;
 * without a hook every call goes to the real file system.
 */
const hooks = vi.hoisted(() => ({
  wrapHandle: null as ((handle: FileHandle) => void) | null,
  lstatIno: null as bigint | null,
  /** Size every `lstat` of a file named `a.txt` reports (a file that grows after the walk). */
  lstatSize: null as number | null,
  realpathCall: null as ((call: number, real: string) => string) | null,
  realpathCalls: 0,
  missingFlags: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      hooks.wrapHandle?.(handle);
      return handle;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      if (hooks.lstatIno !== null) Object.defineProperty(stats, 'ino', { value: hooks.lstatIno });
      if (hooks.lstatSize !== null && String(args[0]).endsWith('a.txt')) {
        Object.defineProperty(stats, 'size', { value: hooks.lstatSize });
      }
      return stats;
    },
    realpath: async (path: string) => {
      const real = await actual.realpath(path);
      hooks.realpathCalls += 1;
      return hooks.realpathCall ? hooks.realpathCall(hooks.realpathCalls, real) : real;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  // A copy of the frozen constants with getters, as the lesson of 2026-10-19 describes.
  const constants = { ...actual.constants };
  Object.defineProperty(constants, 'O_NOFOLLOW', {
    get: () => (hooks.missingFlags ? undefined : actual.constants.O_NOFOLLOW),
  });
  Object.defineProperty(constants, 'O_NONBLOCK', {
    get: () => (hooks.missingFlags ? undefined : actual.constants.O_NONBLOCK),
  });
  return { ...actual, constants };
});

const tmp = useTempDirs();

afterEach(() => {
  hooks.wrapHandle = null;
  hooks.lstatIno = null;
  hooks.lstatSize = null;
  hooks.realpathCall = null;
  hooks.realpathCalls = 0;
  hooks.missingFlags = false;
});

/** A workspace where the agent wrote `a.txt`; returns a capture function for it. */
async function written(content = 'agent output') {
  const dir = join(tmp('ws'), 'workspace');
  mkdirSync(dir);
  const workspace = await pinWorkspace(dir);
  const before = await buildManifest(dir);
  writeFileSync(join(dir, 'a.txt'), content);
  const after = await buildManifest(dir);
  return {
    dir,
    capture: () =>
      captureOutputFiles({
        workspace,
        before,
        measured: { after, changes: diffManifests(before, after) },
        installedPaths: [],
        adapter: new MockAgentAdapter(),
      }),
  };
}

const notListed = { ok: false, reason: 'a.txt is not the file the manifest listed' };

describe('captureOutputFiles on simulated file systems (FR-123-04)', () => {
  it('fails closed on a file system that reports no file ID', async () => {
    const ws = await written();
    hooks.wrapHandle = (handle) => {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (options?: Fs.StatOptions) => {
        const stats = await stat(options as Fs.StatOptions & { bigint: true });
        if (options?.bigint) Object.defineProperty(stats, 'ino', { value: 0n });
        return stats;
      }) as FileHandle['stat'];
    };
    expect(await ws.capture()).toEqual(notListed);
  });

  it('fails when the opened file is not the file at the path', async () => {
    const ws = await written();
    hooks.lstatIno = 12345n;
    expect(await ws.capture()).toEqual(notListed);
  });

  it('fails when the directory resolves elsewhere after the open', async () => {
    const ws = await written();
    // The capture's first check (before the open) passes; the second (after it) sees a swap.
    hooks.realpathCalls = 0;
    hooks.realpathCall = (call, real) => (call === 2 ? `${real}-elsewhere` : real);
    expect(await ws.capture()).toEqual(notListed);
  });

  it('refuses a link by the identity check where the open cannot refuse it (no O_NOFOLLOW)', async () => {
    const ws = await written();
    const outside = join(tmp('outside'), 'a.txt');
    writeFileSync(outside, 'agent output');
    rmSync(join(ws.dir, 'a.txt'));
    symlinkSync(outside, join(ws.dir, 'a.txt'));
    hooks.missingFlags = true;
    expect(await ws.capture()).toEqual(notListed);
  });

  it('captures normally without O_NOFOLLOW and O_NONBLOCK', async () => {
    const ws = await written();
    hooks.missingFlags = true;
    const outcome = await ws.capture();
    expect(outcome.ok && outcome.capture.files[0]?.content).toBe('agent output');
  });

  it('fails when a read error stops the key-marker scan after the window', async () => {
    const ws = await written('a'.repeat(1_200_000));
    let reads = 0;
    hooks.wrapHandle = (handle) => {
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      handle.read = ((...args: unknown[]) => {
        reads += 1;
        if (reads > 1) {
          return Promise.reject(Object.assign(new Error('i/o error'), { code: 'EIO' }));
        }
        return read(...args);
      }) as FileHandle['read'];
    };
    expect(await ws.capture()).toEqual({ ok: false, reason: 'a.txt could not be read (EIO)' });
  });

  it('stops reading a file that grows after the manifest, one byte past its size (Codex round 1)', async () => {
    const ws = await written('x');
    let reads = 0;
    hooks.wrapHandle = (handle) => {
      // An endless file: every read fills the buffer.
      handle.read = ((buffer: Buffer, offset: number, length: number) => {
        reads += 1;
        buffer.fill(0x78, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      }) as unknown as FileHandle['read'];
    };
    expect(await ws.capture()).toEqual({
      ok: false,
      reason: 'a.txt changed after the agent stopped',
    });
    // The window (the whole manifested byte) and the one-byte probe.
    expect(reads).toBe(2);
  });

  it('fails when a file shrinks after its read window', async () => {
    const ws = await written('a'.repeat(1_200_000));
    let reads = 0;
    hooks.wrapHandle = (handle) => {
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      handle.read = ((...args: unknown[]) => {
        reads += 1;
        return reads > 1 ? Promise.resolve({ bytesRead: 0 }) : read(...args);
      }) as FileHandle['read'];
    };
    expect(await ws.capture()).toEqual({
      ok: false,
      reason: 'a.txt changed after the agent stopped',
    });
  });

  it('bounds the own manifest of an agent-error or timeout run on a growing file (Codex round 2)', async () => {
    const dir = join(tmp('ws'), 'workspace');
    mkdirSync(dir);
    const workspace = await pinWorkspace(dir);
    const before = await buildManifest(dir);
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100_000));
    // The walk's lstat saw 1 byte; the file holds more by the time it is hashed.
    hooks.lstatSize = 1;
    expect(
      await captureOutputFiles({
        workspace,
        before,
        measured: null,
        installedPaths: [],
        adapter: new MockAgentAdapter(),
      }),
    ).toEqual({ ok: false, reason: 'File changed while it was read: a.txt' });
  });

  it('fails when the file ends before its read window is full', async () => {
    const ws = await written();
    hooks.wrapHandle = (handle) => {
      handle.read = (() => Promise.resolve({ bytesRead: 0 })) as unknown as FileHandle['read'];
    };
    expect(await ws.capture()).toEqual({
      ok: false,
      reason: 'a.txt changed after the agent stopped',
    });
  });
});
