import { describe, expect, it } from 'vitest';
import { configSchema } from '@directivebench/core';
import { CliError, ExitCode, checkNodeVersion, resolveAssets } from '../src/runtime';
import { resolveServerOptions } from '../src/setup';

const config = configSchema.parse({});

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
