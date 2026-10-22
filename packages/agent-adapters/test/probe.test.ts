import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_ENV_ALLOWLIST,
  findExecutable,
  probeEnv,
  readVersionLine,
  runProbe,
} from '../src/probe';

const posixOnly = describe.skipIf(process.platform === 'win32');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeScript(body: string, shebang = '#!/bin/sh'): string {
  const path = join(tempDir('probe-bin-'), 'tool');
  writeFileSync(path, `${shebang}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const options = { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 64 * 1024 };

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probeEnv', () => {
  it('keeps only allowlisted variables and adds NO_COLOR', () => {
    const env = probeEnv({
      PATH: '/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-planted',
      ANTHROPIC_AUTH_TOKEN: 'planted',
      CLAUDE_CODE_OAUTH_TOKEN: 'planted',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/elsewhere',
      GITHUB_TOKEN: 'planted',
    });
    expect(env).toEqual({ NO_COLOR: '1', PATH: '/bin', HOME: '/home/u', LANG: 'C.UTF-8' });
  });

  it('allowlists no credential or Claude Code configuration variable', () => {
    for (const key of PROBE_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/^(ANTHROPIC_|CLAUDE_)|KEY|TOKEN|SECRET/);
    }
  });
});

posixOnly('runProbe', () => {
  it('returns stdout and exit code 0', async () => {
    const tool = writeScript('echo "out $*"');
    expect(await runProbe(tool, ['a', 'b c'], options)).toEqual({
      exitCode: 0,
      stdout: 'out a b c\n',
      failure: null,
    });
  });

  it('keeps stdout of a non-zero exit', async () => {
    const tool = writeScript('echo partial\nexit 1');
    expect(await runProbe(tool, [], options)).toEqual({
      exitCode: 1,
      stdout: 'partial\n',
      failure: null,
    });
  });

  it('runs in a fresh empty directory that is removed afterwards, with the probe env', async () => {
    const tool = writeScript('pwd\nls -A | wc -l\nenv | sort');
    const { stdout } = await runProbe(tool, [], {
      ...options,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-planted' },
    });
    const [cwd, entries, ...envLines] = stdout.trim().split('\n');
    expect(cwd).toContain('directivebench-probe-');
    expect(cwd).not.toBe(process.cwd());
    expect(entries?.trim()).toBe('0');
    expect(existsSync(cwd!)).toBe(false);
    expect(envLines.join('\n')).not.toContain('sk-ant-planted');
    expect(envLines).toContain('NO_COLOR=1');
  });

  it('reports a timeout and kills a child that ignores SIGTERM', async () => {
    const tool = writeScript("trap '' TERM\nsleep 3");
    const started = Date.now();
    expect(await runProbe(tool, [], { ...options, timeoutMs: 100 })).toEqual({
      exitCode: null,
      stdout: '',
      failure: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('does not wait for a grandchild that holds the output open', async () => {
    const tool = writeScript('sleep 3 &\nsleep 3');
    const started = Date.now();
    const probe = await runProbe(tool, [], { ...options, timeoutMs: 100 });
    expect(probe).toEqual({ exitCode: null, stdout: '', failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('reports output above the limit without keeping it', async () => {
    const tool = writeScript(`printf '%0500d\\n' 0`);
    expect(await runProbe(tool, [], { ...options, maxOutputBytes: 100 })).toEqual({
      exitCode: null,
      stdout: '',
      failure: 'output-limit',
    });
  });

  it('reports a process that cannot start', async () => {
    const tool = writeScript('echo never', '#!/nonexistent/interpreter');
    expect((await runProbe(tool, [], options)).failure).toBe('failed');
  });

  it('reports a process killed by a signal', async () => {
    const tool = writeScript('echo before\nkill -9 $$');
    expect(await runProbe(tool, [], options)).toEqual({
      exitCode: null,
      stdout: '',
      failure: 'failed',
    });
  });
});

posixOnly('readVersionLine', () => {
  it('ignores the output of a failing version command', async () => {
    const tool = writeScript('echo "1.0.0"\nexit 2');
    expect(await readVersionLine(tool, ['--version'], { PATH: process.env.PATH })).toBeNull();
  });
});

posixOnly('findExecutable', () => {
  it('skips relative PATH entries, which resolve against the working directory', async () => {
    const tool = writeScript('echo planted');
    const dir = join(tool, '..');
    expect(await findExecutable('tool', { PATH: relative(process.cwd(), dir) })).toBeNull();
    expect(await findExecutable('tool', { PATH: `.:${dir}` })).toBe(tool);
  });
});

posixOnly('runProbe without a usable temp directory', () => {
  it('reports failed instead of rejecting when the working directory cannot be created', async () => {
    const tool = writeScript('echo never');
    vi.stubEnv('TMPDIR', join(tempDir('probe-tmp-'), 'missing', 'dir'));
    expect(await runProbe(tool, [], options)).toEqual({
      exitCode: null,
      stdout: '',
      failure: 'failed',
    });
  });

  it('keeps the result when the working directory cannot be removed', async () => {
    // The probe leaves a directory it cannot delete from (mode 0500) in its working directory.
    const tool = writeScript('mkdir locked && touch locked/file && chmod 500 locked && echo done');
    const tmp = tempDir('probe-tmp-');
    vi.stubEnv('TMPDIR', tmp);
    expect(await runProbe(tool, [], options)).toEqual({
      exitCode: 0,
      stdout: 'done\n',
      failure: null,
    });
    for (const entry of readdirSync(tmp)) chmodSync(join(tmp, entry, 'locked'), 0o700);
  });
});
