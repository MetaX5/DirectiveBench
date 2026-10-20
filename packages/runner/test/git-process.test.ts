import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_MAX_STDERR_BYTES, runGitProcess, type GitProcessOptions } from '../src/git-process';

// `/bin/sh -c <script>` stands in for git: the runner treats both as an argv program.
const SH = '/bin/sh';
const posixOnly = it.skipIf(process.platform === 'win32');

function options(overrides: Partial<GitProcessOptions> = {}): GitProcessOptions {
  return {
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
    maxStdoutBytes: 1024 * 1024,
    signal: new AbortController().signal,
    killGraceMs: 50,
    knownSecrets: [],
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('runGitProcess', () => {
  posixOnly('returns raw standard output and redacted, bounded error output', async () => {
    const result = await runGitProcess(
      SH,
      [
        '-c',
        'printf "a\\377\\000ghp_abcdefghijklmnopqrstuvwxyz"; printf "fatal: ghp_abcdefghijklmnopqrstuvwxyz http://user:pw@proxy" >&2; head -c 70000 /dev/zero | tr "\\0" x >&2; sleep 0.05; echo more >&2; exit 3',
      ],
      options({ knownSecrets: ['http://user:pw@proxy'] }),
    );
    expect(result.exitCode).toBe(3);
    // Standard output is never redacted or decoded.
    expect(result.stdout).toEqual(
      Buffer.concat([
        Buffer.from([0x61, 0xff, 0x00]),
        Buffer.from('ghp_abcdefghijklmnopqrstuvwxyz'),
      ]),
    );
    expect(result.stderr.startsWith('fatal: [REDACTED] [REDACTED]')).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(GIT_MAX_STDERR_BYTES);
    expect(result).toMatchObject({ timedOut: false, cancelled: false, outputExceeded: false });
  });

  posixOnly('feeds standard input', async () => {
    const result = await runGitProcess(SH, ['-c', 'cat'], options({ stdin: Buffer.from('in\n') }));
    expect(result.stdout.toString()).toBe('in\n');
    expect(result.error).toBeNull();
  });

  posixOnly('records an input git did not read instead of throwing', async () => {
    const result = await runGitProcess(
      SH,
      ['-c', 'exit 0'],
      options({ stdin: Buffer.alloc(16 * 1024 * 1024) }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.error).toMatch(/^git's input could not be written: /);
  });

  it('does not start git for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGitProcess(
      '/nonexistent/git',
      [],
      options({ signal: controller.signal }),
    );
    expect(result).toMatchObject({ cancelled: true, exitCode: null, stderr: '' });
  });

  it('reports a git that cannot be started, also when cancelled before it failed', async () => {
    const result = await runGitProcess('/nonexistent/git', [], options());
    expect(result.error).toMatch(/ENOENT/);
    const controller = new AbortController();
    const pending = runGitProcess('/nonexistent/git', [], options({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({
      cancelled: true,
      error: expect.stringMatching(/ENOENT/),
    });
  });

  posixOnly('kills git on timeout, with SIGKILL when it ignores SIGTERM', async () => {
    const result = await runGitProcess(
      SH,
      ['-c', 'trap "" TERM; sleep 5 & wait; sleep 5'],
      options({ timeoutMs: 50 }),
    );
    expect(result.timedOut).toBe(true);
  });

  posixOnly('kills git when the job is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runGitProcess(
      SH,
      ['-c', 'sleep 5'],
      options({ signal: controller.signal }),
    );
    expect(result.cancelled).toBe(true);
  });

  posixOnly('kills git when it prints more than the limit', async () => {
    const result = await runGitProcess(
      SH,
      ['-c', 'head -c 1000000 /dev/zero; sleep 5'],
      options({ maxStdoutBytes: 1000 }),
    );
    expect(result.outputExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  posixOnly('keeps checking a watch until it fires, then kills git', async () => {
    let checks = 0;
    const result = await runGitProcess(
      SH,
      ['-c', 'sleep 5'],
      options({ watch: { intervalMs: 5, exceeded: async () => ++checks >= 3 } }),
    );
    expect(checks).toBe(3);
    expect(result.watchTriggered).toBe(true);
  });

  posixOnly('stops git when the watch itself fails (fail closed)', async () => {
    const result = await runGitProcess(
      SH,
      ['-c', 'sleep 5'],
      options({
        watch: {
          intervalMs: 5,
          exceeded: async () => {
            throw new Error('EACCES');
          },
        },
      }),
    );
    expect(result).toMatchObject({
      watchTriggered: true,
      error: 'The running check failed: EACCES',
    });
  });

  posixOnly('ignores a watch result that arrives after git exited', async () => {
    let finish = (_value: boolean): void => undefined;
    const exceeded = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const result = await runGitProcess(
      SH,
      ['-c', 'sleep 0.1'],
      options({ watch: { intervalMs: 1, exceeded } }),
    );
    finish(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.watchTriggered).toBe(false);
    expect(exceeded).toHaveBeenCalledTimes(1);
  });

  posixOnly('ignores a watch failure that arrives after git exited', async () => {
    let fail = (_error: Error): void => undefined;
    const result = await runGitProcess(
      SH,
      ['-c', 'sleep 0.1'],
      options({
        watch: {
          intervalMs: 1,
          exceeded: () =>
            new Promise<boolean>((_resolve, reject) => {
              fail = reject;
            }),
        },
      }),
    );
    // A late failure must not signal a process group that may already belong to another process.
    const kill = vi.spyOn(process, 'kill');
    fail(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ watchTriggered: false, error: null });
  });

  posixOnly('survives a process group that is already gone when it is signalled', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const result = await runGitProcess(SH, ['-c', 'sleep 5'], options({ timeoutMs: 20 }));
    // The SIGTERM failed; the SIGKILL after the grace period stopped git.
    expect(kill).toHaveBeenCalledTimes(2);
    expect(result.timedOut).toBe(true);
  });

  posixOnly('signals the child itself where process groups do not exist (Windows)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let pending;
    try {
      // `exec`: without a process group, only the child itself is signalled.
      pending = runGitProcess(SH, ['-c', 'exec sleep 5'], options({ timeoutMs: 20 }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect((await pending).timedOut).toBe(true);
  });
});
