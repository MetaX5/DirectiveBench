import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import type * as FsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Interleavings another process cannot produce on cue — a lock released between our failed `wx`
 * create and the check, or replaced while we hold it — are injected by wrapping `statSync` and
 * `renameSync` (the latter runs inside the locked section, in the atomic config write).
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const { ensureInstallationId } = await import('../src/config');

const dirs: string[] = [];
function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-config-lock-'));
  dirs.push(dir);
  return join(dir, 'config.json');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` while `renameSync` first does `before` (inside the locked section). */
function duringLockedWrite(before: () => void): void {
  const actual = vi.mocked(fs.renameSync).getMockImplementation() as typeof fs.renameSync;
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    before();
    actual(from, to);
  });
}

describe('config lock interleavings', () => {
  it('tries again when the lock is released just as the timeout is reached', () => {
    const path = configPath();
    writeFileSync(`${path}.lock`, 'token-of-another-process');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    vi.mocked(fs.statSync).mockImplementationOnce(() => {
      // The holder finishes right now: the lock is gone when we look at it.
      rmSync(`${path}.lock`);
      return undefined;
    });
    expect(ensureInstallationId(path).installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('never removes a lock that holds another token', () => {
    const path = configPath();
    duringLockedWrite(() => writeFileSync(`${path}.lock`, 'token-of-another-process'));
    expect(ensureInstallationId(path).installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe('token-of-another-process');
  });

  it('accepts a lock someone deleted while it was held', () => {
    const path = configPath();
    duringLockedWrite(() => rmSync(`${path}.lock`));
    expect(ensureInstallationId(path).installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('reports a lock it cannot read on release instead of guessing', () => {
    const path = configPath();
    duringLockedWrite(() => {
      rmSync(`${path}.lock`);
      mkdirSync(`${path}.lock`);
    });
    expect(() => ensureInstallationId(path)).toThrow(/EISDIR/);
    expect(existsSync(`${path}.lock`)).toBe(true);
  });
});
