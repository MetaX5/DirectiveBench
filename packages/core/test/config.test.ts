import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig, resolveDataDir, saveConfig } from '../src/config';
import { canonicalJson, hashManifest } from '../src/hash';
import { redactSecrets } from '../src/redact';

describe('resolveDataDir', () => {
  it('prefers the flag, then the environment variable', () => {
    expect(resolveDataDir({ flag: '/tmp/a', env: { DIRECTIVEBENCH_DATA_DIR: '/tmp/b' } })).toBe(
      '/tmp/a',
    );
    expect(resolveDataDir({ env: { DIRECTIVEBENCH_DATA_DIR: '/tmp/b' } })).toBe('/tmp/b');
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
});

describe('config', () => {
  it('returns defaults when the file does not exist and round-trips atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-config-'));
    const path = join(dir, 'config.json');
    const defaults = loadConfig(path);
    expect(defaults.server).toEqual({ host: '127.0.0.1', port: 4280, openBrowser: true });
    saveConfig(path, { ...defaults, runner: { concurrency: 2, keepWorkspaces: true } });
    expect(loadConfig(path).runner.concurrency).toBe(2);
  });

  it('rejects invalid and unknown settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ server: { port: 99999 } }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    writeFileSync(path, JSON.stringify({ unknown: true }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    writeFileSync(path, '{');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{');
  });

  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.2')).toBe(false);
  });
});

describe('hashing', () => {
  it('is independent of manifest order', () => {
    const a = { path: 'a', sha256: '1' };
    const b = { path: 'b', sha256: '2' };
    expect(hashManifest([a, b])).toBe(hashManifest([b, a]));
    expect(hashManifest([a])).not.toBe(hashManifest([b]));
  });

  it('serialises JSON canonically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
  });
});

describe('redactSecrets', () => {
  it('removes known secret values and token shapes', () => {
    const text = [
      'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'gh: ghp_abcdefghijklmnopqrstuvwxyz0123',
      'gitlab: glpat-abcdefghijklmnopqrstu',
      'Authorization: Bearer abc.def.ghi',
      'custom: my-super-secret-value',
    ].join('\n');
    const redacted = redactSecrets(text, ['my-super-secret-value']);
    expect(redacted).not.toMatch(/sk-ant-api03|ghp_|glpat-|abc\.def|my-super-secret/);
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
  });
});
