import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Races a test cannot schedule for real (an entry replaced between two system calls) are
 * simulated by letting a hook replace one call of the wrapped `node:fs/promises` functions.
 */
const hooks: {
  rename?: (
    from: string,
    to: string,
    actual: (a: string, b: string) => Promise<void>,
  ) => Promise<void>;
  readdir?: (path: string) => Promise<unknown> | undefined;
  lstat?: (path: string) => Promise<unknown> | undefined;
  readlink?: (path: string) => Promise<unknown> | undefined;
  open?: (path: string, handle: FsPromises.FileHandle) => FsPromises.FileHandle;
} = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readdir: (path: string) => hooks.readdir?.(path) ?? actual.readdir(path),
    rename: (from: string, to: string) =>
      hooks.rename ? hooks.rename(from, to, actual.rename) : actual.rename(from, to),
    lstat: (path: string) => hooks.lstat?.(path) ?? actual.lstat(path),
    readlink: (path: string) => hooks.readlink?.(path) ?? actual.readlink(path),
    open: async (path: string, flags: string | number) => {
      const handle = await actual.open(path, flags);
      return hooks.open ? hooks.open(path, handle) : handle;
    },
  };
});

const { inspectWorkspace, installClaudeArtifact, ClaudeCodeError, WORKSPACE_SCAN_MAX_FILES } =
  await import('../../src/claude-code');
const { bundle } = await import('./helpers');

let scratch: string;
let workspace: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'db-claude-race-')));
  workspace = join(scratch, 'workspace');
  await mkdir(workspace);
});

afterEach(async () => {
  delete hooks.rename;
  delete hooks.readdir;
  delete hooks.lstat;
  delete hooks.readlink;
  delete hooks.open;
  await rm(scratch, { recursive: true, force: true });
});

function failing(code: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(code), { code }));
}

/** A handle whose `stat` or `read` reports something else than the file the walk saw. */
function lying(
  handle: FsPromises.FileHandle,
  change: { ino?: number; bytesRead?: number },
): FsPromises.FileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'stat' && change.ino !== undefined) {
        return async () => Object.assign(await target.stat(), { ino: change.ino });
      }
      if (property === 'read' && change.bytesRead !== undefined) {
        return async () => ({ bytesRead: change.bytesRead, buffer: Buffer.alloc(0) });
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('inspectWorkspace entry limit', () => {
  it('refuses more entries than WORKSPACE_SCAN_MAX_FILES before inspecting the extra one', async () => {
    // A listing of the limit plus one names, without creating them: the walk counts entries
    // before it calls lstat, so the last name is never inspected.
    const names = Array.from({ length: WORKSPACE_SCAN_MAX_FILES + 1 }, (_, index) => `f${index}`);
    const file = await lstat(workspace);
    const inspected: string[] = [];
    hooks.readdir = (path) => (path === workspace ? Promise.resolve([...names]) : undefined);
    hooks.lstat = (path) => {
      if (!path.startsWith(`${workspace}/f`)) return undefined;
      inspected.push(path);
      return Promise.resolve(
        Object.assign(Object.create(Object.getPrototypeOf(file)), file, {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => false,
        }),
      );
    };
    const findings = await inspectWorkspace(workspace, { homeDir: scratch });
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'workspace-scan-limit',
        detail: `more than ${WORKSPACE_SCAN_MAX_FILES} entries in the workspace`,
      }),
    ]);
    expect(inspected).toHaveLength(WORKSPACE_SCAN_MAX_FILES);
  });
});

describe('inspectWorkspace under races', () => {
  it('fails closed on an entry that vanishes between listing and lstat', async () => {
    await writeFile(join(workspace, 'gone.md'), 'x');
    hooks.lstat = (path) => (path.endsWith('gone.md') ? failing('ENOENT') : undefined);
    const findings = await inspectWorkspace(workspace, { homeDir: scratch });
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'workspace-contains-claude-config',
        path: 'gone.md',
        detail: 'the entry cannot be inspected (ENOENT)',
      }),
    ]);
  });

  it('names an error without a code', async () => {
    await writeFile(join(workspace, 'odd.md'), 'x');
    hooks.lstat = (path) =>
      path.endsWith('odd.md') ? Promise.reject(new Error('odd')) : undefined;
    expect(await inspectWorkspace(workspace, { homeDir: scratch })).toEqual([
      expect.objectContaining({ detail: 'the entry cannot be inspected (unknown error)' }),
    ]);
  });

  it('fails closed on a file replaced or shortened before it is read', async () => {
    await writeFile(join(workspace, 'a.md'), 'x');
    for (const change of [{ ino: -1 }, { bytesRead: 0 }]) {
      hooks.open = (path, handle) => (path.endsWith('a.md') ? lying(handle, change) : handle);
      expect(await inspectWorkspace(workspace, { homeDir: scratch })).toEqual([
        expect.objectContaining({
          code: 'workspace-imports-outside',
          path: 'a.md',
          detail: 'the file cannot be read (ECHANGED), so its imports cannot be checked',
        }),
      ]);
    }
  });

  it('still reports an outside link whose text cannot be read', async () => {
    await symlink(scratch, join(workspace, 'out'));
    hooks.readlink = () => failing('EINVAL');
    expect(await inspectWorkspace(workspace, { homeDir: scratch })).toEqual([
      expect.objectContaining({ path: 'out', token: '(EINVAL)', target: scratch }),
    ]);
  });
});

describe('installClaudeArtifact under races', () => {
  const host = () => join(scratch, 'host');

  it('never writes outside when a setup process links .claude or .claude/rules out before the move', async () => {
    await mkdir(host());
    for (const [format, files, planted] of [
      ['skill-md', { 'SKILL.md': '---\nname: pdf\n---\n' }, '.claude'],
      ['claude-rule', { 'r.md': 'rule' }, '.claude'],
    ] as const) {
      hooks.rename = async (from, to, rename) => {
        // The interleaving Codex reproduced: the workspace entry is replaced right before the move.
        await symlink(host(), join(workspace, planted));
        return rename(from, to);
      };
      await expect(installClaudeArtifact(workspace, bundle(format, files))).rejects.toMatchObject({
        code: 'artifact-install-conflict',
      });
      expect(await readdir(host())).toEqual([]);
      await rm(join(workspace, planted));
    }
    await mkdir(join(workspace, '.claude'));
    await symlink(host(), join(workspace, '.claude', 'rules'));
    delete hooks.rename;
    await expect(
      installClaudeArtifact(workspace, bundle('claude-rule', { 'r.md': 'rule' })),
    ).rejects.toMatchObject({ code: 'artifact-install-conflict' });
    expect(await readdir(host())).toEqual([]);
  });

  it('fails closed when an installed entry is replaced right after the move', async () => {
    await mkdir(host());
    for (const [format, files, name] of [
      ['skill-md', { 'SKILL.md': 'x' }, '.claude'],
      ['claude-md', { 'CLAUDE.md': 'x' }, 'CLAUDE.md'],
    ] as const) {
      hooks.rename = async (from, to, rename) => {
        await rename(from, to);
        await rm(to, { recursive: true });
        await symlink(host(), to);
      };
      await expect(installClaudeArtifact(workspace, bundle(format, files))).rejects.toMatchObject({
        code: 'artifact-install-conflict',
        message: expect.stringMatching(/replaced after installation/),
      });
      await rm(join(workspace, name));
    }
  });

  it('propagates a move error that is not an occupied destination', async () => {
    hooks.rename = () => failing('EXDEV');
    await expect(
      installClaudeArtifact(workspace, bundle('claude-md', { 'CLAUDE.md': 'x' })),
    ).rejects.toMatchObject({ code: 'EXDEV' });
  });

  it('refuses an instruction file replaced between lstat and open', async () => {
    await writeFile(join(workspace, 'CLAUDE.md'), 'fixture');
    hooks.open = (path, handle) =>
      path.endsWith('CLAUDE.md') ? lying(handle, { ino: -1 }) : handle;
    const install = installClaudeArtifact(workspace, bundle('claude-md', { 'CLAUDE.md': 'x' }));
    await expect(install).rejects.toBeInstanceOf(ClaudeCodeError);
    await expect(install).rejects.toMatchObject({ code: 'artifact-install-conflict' });
  });
});
