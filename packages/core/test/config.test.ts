import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  dataDirLayout,
  isLoopbackHost,
  loadConfig,
  resolveDataDir,
  saveConfig,
} from '../src/config';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDataDir', () => {
  it('prefers the flag, then the environment variable', () => {
    expect(resolveDataDir({ flag: '/tmp/a', env: { DIRECTIVEBENCH_DATA_DIR: '/tmp/b' } })).toBe(
      '/tmp/a',
    );
    expect(resolveDataDir({ env: { DIRECTIVEBENCH_DATA_DIR: '/tmp/b' } })).toBe('/tmp/b');
  });

  it('resolves relative overrides against the working directory', () => {
    expect(resolveDataDir({ flag: 'data' })).toBe(join(process.cwd(), 'data'));
  });

  it('uses OS conventions', () => {
    expect(resolveDataDir({ env: {}, platform: 'linux', home: '/home/u' })).toBe(
      '/home/u/.local/share/directivebench',
    );
    expect(resolveDataDir({ env: { XDG_DATA_HOME: '/x' }, platform: 'linux', home: '/h' })).toBe(
      '/x/directivebench',
    );
    expect(resolveDataDir({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/directivebench',
    );
  });

  it('uses LOCALAPPDATA on Windows and falls back to the profile directory', () => {
    expect(
      resolveDataDir({ env: { LOCALAPPDATA: '/appdata' }, platform: 'win32', home: '/u' }),
    ).toBe(join('/appdata', 'directivebench'));
    expect(resolveDataDir({ env: {}, platform: 'win32', home: '/u' })).toBe(
      join('/u', 'AppData', 'Local', 'directivebench'),
    );
  });

  it('defaults to the process environment, platform and home directory', () => {
    vi.stubEnv('DIRECTIVEBENCH_DATA_DIR', '/tmp/from-env');
    expect(resolveDataDir()).toBe('/tmp/from-env');

    const env = { XDG_DATA_HOME: '/xdg', LOCALAPPDATA: '/appdata' };
    expect(resolveDataDir({ env })).toBe(
      resolveDataDir({ env, platform: process.platform, home: homedir() }),
    );
  });
});

describe('dataDirLayout', () => {
  it('places every managed file and directory inside the root', () => {
    expect(dataDirLayout('/data')).toEqual({
      root: '/data',
      database: join('/data', 'directivebench.db'),
      config: join('/data', 'config.json'),
      fixtures: join('/data', 'fixtures'),
      logs: join('/data', 'logs'),
      cache: join('/data', 'cache'),
    });
  });
});

describe('config', () => {
  it('returns defaults when the file does not exist and round-trips atomically', () => {
    const path = join(tempDir(), 'config.json');
    const defaults = loadConfig(path);
    expect(defaults).toEqual({
      configVersion: 1,
      server: { host: '127.0.0.1', port: 4280, openBrowser: true },
      runner: { concurrency: 1, keepWorkspaces: false },
    });
    saveConfig(path, { ...defaults, runner: { concurrency: 2, keepWorkspaces: true } });
    expect(loadConfig(path).runner).toEqual({ concurrency: 2, keepWorkspaces: true });
  });

  it('creates missing parent directories, leaves no temp file and restricts permissions', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'config.json');
    saveConfig(path, loadConfig(path));
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json']);
    expect(readFileSync(path, 'utf8')).toMatch(/\n$/);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to save an invalid configuration', () => {
    const path = join(tempDir(), 'config.json');
    const config = loadConfig(path);
    expect(() => saveConfig(path, { ...config, server: { ...config.server, port: 0 } })).toThrow();
    expect(() => readFileSync(path)).toThrow();
  });

  it('rejects invalid and unknown settings', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, JSON.stringify({ server: { port: 99999 } }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    writeFileSync(path, JSON.stringify({ unknown: true }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    writeFileSync(path, '{');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{');
  });

  it('propagates read errors other than a missing file', () => {
    const dir = tempDir();
    let caught: unknown;
    try {
      loadConfig(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(ConfigError);
    expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.20.30')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.2')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });
});
