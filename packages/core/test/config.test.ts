import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  dataDirLayout,
  ensureInstallationId,
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

describe('ensureInstallationId (SPEC-115 FR-115-15)', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('creates a missing file with every default and a generated identifier', () => {
    const path = join(tempDir(), 'config.json');
    const config = ensureInstallationId(path);
    expect(config.installationId).toMatch(uuid);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      configVersion: 1,
      server: { host: '127.0.0.1', port: 4280, openBrowser: true },
      runner: { concurrency: 1, keepWorkspaces: false },
      installationId: config.installationId,
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    // Created once: later calls return the stored identifier and leave the file alone.
    const written = readFileSync(path, 'utf8');
    expect(ensureInstallationId(path).installationId).toBe(config.installationId);
    expect(readFileSync(path, 'utf8')).toBe(written);
    expect(loadConfig(path).installationId).toBe(config.installationId);
  });

  it('adds the identifier to an existing file and keeps its keys as written', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, JSON.stringify({ runner: { concurrency: 2 } }));
    const config = ensureInstallationId(path);
    expect(config.runner).toEqual({ concurrency: 2, keepWorkspaces: false });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      runner: { concurrency: 2 },
      installationId: config.installationId,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'writes a symlinked config.json through to its target',
    () => {
      const dir = tempDir();
      const target = join(dir, 'dotfiles-config.json');
      writeFileSync(target, JSON.stringify({ server: { port: 5000 } }));
      const path = join(dir, 'config.json');
      symlinkSync(target, path);
      const config = ensureInstallationId(path);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
        server: { port: 5000 },
        installationId: config.installationId,
      });
    },
  );

  it('gives every data directory its own identifier', () => {
    const a = ensureInstallationId(join(tempDir(), 'config.json')).installationId;
    const b = ensureInstallationId(join(tempDir(), 'config.json')).installationId;
    expect(a).not.toBe(b);
  });

  it('never rewrites an invalid file and rejects an identifier that is not a UUID', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, '{ broken');
    expect(() => ensureInstallationId(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ broken');
    writeFileSync(path, JSON.stringify({ installationId: 'host-1' }));
    expect(() => ensureInstallationId(path)).toThrow(ConfigError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ installationId: 'host-1' });
  });
});
