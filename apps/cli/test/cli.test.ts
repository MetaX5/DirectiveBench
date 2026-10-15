import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '@directivebench/core';
import { doctorCommand } from '../src/commands';
import { CliError, ExitCode, checkNodeVersion, resolveAssets } from '../src/runtime';
import { resolveServerOptions } from '../src/setup';

const config = configSchema.parse({});
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveServerOptions', () => {
  it('applies flag > env > config precedence', () => {
    expect(resolveServerOptions({}, config, {})).toEqual({ host: '127.0.0.1', port: 4280 });
    expect(resolveServerOptions({}, config, { DIRECTIVEBENCH_PORT: '5000' }).port).toBe(5000);
    expect(
      resolveServerOptions({ port: '6000' }, config, { DIRECTIVEBENCH_PORT: '5000' }).port,
    ).toBe(6000);
  });

  it('rejects invalid ports with a usage error', () => {
    expect(() => resolveServerOptions({ port: '70000' }, config, {})).toThrow(CliError);
    try {
      resolveServerOptions({ port: 'abc' }, config, {});
    } catch (error) {
      expect((error as CliError).exitCode).toBe(ExitCode.Usage);
    }
  });

  it('requires explicit opt-in for non-loopback hosts', () => {
    expect(() => resolveServerOptions({ host: '0.0.0.0' }, config, {})).toThrow(
      /allow-network-access/,
    );
    expect(
      resolveServerOptions({ host: '0.0.0.0', allowNetworkAccess: true }, config, {}).host,
    ).toBe('0.0.0.0');
  });
});

describe('runtime checks', () => {
  it('compares Node.js versions against the minimum', () => {
    expect(checkNodeVersion('22.16.0').ok).toBe(true);
    expect(checkNodeVersion('24.0.0').ok).toBe(true);
    expect(checkNodeVersion('22.15.9').ok).toBe(false);
    expect(checkNodeVersion('20.19.0').ok).toBe(false);
  });

  it('locates assets from source without depending on the working directory', () => {
    const assets = resolveAssets();
    expect(assets.mode).toBe('source');
    expect(assets.migrationsDir).toMatch(/packages\/database\/migrations$/);
    expect(assets.nextBin).toMatch(/next\/dist\/bin\/next$/);
  });
});

describe('doctor', () => {
  async function runDoctor(dataDir: string) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const code = await doctorCommand({ dataDir, json: true });
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        checks: { name: string; status: string; hint?: string }[];
      };
      return { code, checks: output.checks };
    } finally {
      log.mockRestore();
    }
  }

  it('warns with a hint when the data directory does not exist yet', async () => {
    const { code, checks } = await runDoctor(join(tempDir('db-doctor-'), 'new'));
    expect(code).toBe(ExitCode.Ok);
    expect(checks.find((c) => c.name === 'data-dir')).toMatchObject({
      status: 'warn',
      hint: expect.stringContaining('directivebench init'),
    });
    expect(checks.filter((c) => c.status !== 'ok').every((c) => c.hint)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails when the data directory is not writable',
    async () => {
      const dir = tempDir('db-doctor-ro-');
      chmodSync(dir, 0o500);
      const { code, checks } = await runDoctor(dir);
      expect(code).toBe(ExitCode.CheckFailed);
      expect(checks.find((c) => c.name === 'data-dir')?.status).toBe('fail');
      chmodSync(dir, 0o700);
    },
  );
});
