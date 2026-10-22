import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import type * as FsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A lock released between the failed `wx` open and the age check cannot be produced reliably by
 * another process, so `statSync` is replaced to report it as gone exactly once.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const { ensureInstallationId } = await import('../src/config');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config lock released while it is being checked', () => {
  it('tries again at once instead of treating the lock as held', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-config-lock-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(`${path}.lock`, '12345');
    vi.mocked(fs.statSync).mockImplementationOnce(() => {
      // The holder finishes right now: the lock is gone when we look at it.
      rmSync(`${path}.lock`);
      return undefined;
    });
    expect(ensureInstallationId(path).installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
