import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliError,
  ExitCode,
  assertSupportedRuntime,
  checkNodeVersion,
  checkSqlite,
  resolveAssets,
} from '../src/runtime';
import { fakeNodeVersion } from './support/node-version';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkNodeVersion', () => {
  it('treats missing minor and patch components as zero', () => {
    expect(checkNodeVersion('23')).toEqual({
      ok: true,
      message: 'Node.js 23 (requires >= 22.16.0)',
    });
    expect(checkNodeVersion('22').ok).toBe(false);
    expect(checkNodeVersion('22.17').ok).toBe(true);
    expect(checkNodeVersion('').ok).toBe(false);
  });

  it('defaults to the running Node.js version', () => {
    expect(checkNodeVersion().message).toContain(process.versions.node);
  });
});

describe('assertSupportedRuntime', () => {
  it('accepts the running Node.js', () => {
    expect(() => assertSupportedRuntime()).not.toThrow();
  });

  it('rejects an old Node.js with the unsupported-runtime exit code', () => {
    const restore = fakeNodeVersion('20.11.1');
    let caught: unknown;
    try {
      assertSupportedRuntime();
    } catch (error) {
      caught = error;
    } finally {
      restore();
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      exitCode: ExitCode.UnsupportedRuntime,
      message: 'Unsupported runtime: Node.js 20.11.1 (requires >= 22.16.0)',
    });
  });
});

describe('checkSqlite', () => {
  it('reports the SQLite version bundled with Node.js', async () => {
    const result = await checkSqlite();
    expect(result.ok).toBe(true);
    expect(result.message).toBe(`node:sqlite available (SQLite ${process.versions.sqlite})`);
  });
});

describe('resolveAssets', () => {
  it('uses the packaged layout when a built web app sits next to the bundle', () => {
    const here = tempDir();
    mkdirSync(join(here, 'web', '.next'), { recursive: true });
    writeFileSync(join(here, 'web', '.next', 'BUILD_ID'), 'build');
    const assets = resolveAssets(here);
    expect(assets).toMatchObject({
      mode: 'packaged',
      webDir: join(here, 'web'),
      migrationsDir: join(here, 'migrations'),
      examplesDir: join(here, 'examples'),
    });
    expect(assets.nextBin).toMatch(/next\/dist\/bin\/next$/);
  });

  it('fails with a runtime error when neither layout is present', () => {
    const here = join(tempDir(), 'a', 'b', 'c');
    expect(() => resolveAssets(here)).toThrow(
      new CliError(`Cannot locate the bundled web application next to ${here}`, ExitCode.Runtime),
    );
    try {
      resolveAssets(here);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(ExitCode.Runtime);
    }
  });
});
