import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoCommand, initCommand } from '../src/commands';
import { ExitCode } from '../src/runtime';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-commands-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function capture(command: () => Promise<number>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await command();
  const output = log.mock.calls.map((call) => String(call[0])).join('\n');
  log.mockRestore();
  return { code, output };
}

describe('init', () => {
  it('creates the workspace and reports what it did, then keeps it on a second run', async () => {
    const dataDir = join(tempDir(), 'data');
    const first = await capture(() => initCommand({ dataDir }));
    expect(first.code).toBe(ExitCode.Ok);
    expect(first.output).toContain(`Data directory: ${dataDir}`);
    expect(first.output).toContain(`config:     created ${join(dataDir, 'config.json')}`);
    expect(first.output).toMatch(/directivebench\.db \([1-9]\d* migration\(s\) applied\)/);
    expect(first.output).toContain('Initialised.');

    const second = await capture(() => initCommand({ dataDir }));
    expect(second.output).toContain(`config:     kept ${join(dataDir, 'config.json')}`);
    expect(second.output).toContain('(0 migration(s) applied)');
  });
});

describe('demo', () => {
  it('runs the bundled example with the mock agent and reports an improvement', async () => {
    const dataDir = tempDir();
    const first = await capture(() => demoCommand({ dataDir }));
    expect(first.code).toBe(ExitCode.Ok);
    expect(first.output).toMatch(/^Artifact: {2}.+ v\S+ \(imported\)$/m);
    expect(first.output).toMatch(/^Benchmark: .+ v\S+ \(imported\)$/m);
    expect(first.output).toContain('Mock agent — not an AI evaluation.');
    expect(first.output).toMatch(/Delta: +\+\d+\.\d points/);
    expect(first.output).toMatch(/Verdict: +improved \(confidence: \w+\)/);
    expect(first.output).toMatch(/Run id: +\S+/);

    // Importing the same example again reuses the stored versions.
    const second = await capture(() => demoCommand({ dataDir }));
    expect(second.code).toBe(ExitCode.Ok);
    expect(second.output).not.toContain('(imported)');
  }, 60_000);
});
