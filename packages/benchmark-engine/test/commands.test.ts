import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KILL_GRACE_MS,
  buildCommandEnv,
  runCommand,
  type CommandOptions,
} from '../src/commands';
import { nodeScript, useTempDirs } from './helpers';

const tmp = useTempDirs();
const posixOnly = it.skipIf(process.platform === 'win32');

function options(overrides: Partial<CommandOptions> = {}): CommandOptions {
  const home = tmp('home');
  return {
    cwd: home,
    env: buildCommandEnv(home, { PATH: process.env.PATH }),
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('buildCommandEnv (environment allowlist)', () => {
  it('forwards only allowlisted variables and isolates HOME and temp directories', () => {
    const env = buildCommandEnv('/run/home', {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
      GITHUB_TOKEN: 'ghp_should_not_leak',
      AWS_SECRET_ACCESS_KEY: 'x',
      HOME: '/home/real-user',
      TMPDIR: '/tmp/real',
      NODE_OPTIONS: '--require /tmp/evil.js',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      HOME: '/run/home',
      USERPROFILE: '/run/home',
      TMPDIR: '/run/home',
      TEMP: '/run/home',
      TMP: '/run/home',
      CI: 'true',
      NO_COLOR: '1',
    });
  });

  it('reads the current process environment by default', () => {
    const env = buildCommandEnv('/run/home');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe('/run/home');
  });
});

// Variables the operating system adds to every process it starts, whatever the parent passes.
// macOS (CoreFoundation) sets __CF_USER_TEXT_ENCODING; it does not come from the parent's env.
const OS_INJECTED_ENV = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];

describe('runCommand', () => {
  it('runs in the given working directory with exactly the given environment', async () => {
    const opts = options({ env: { PATH: process.env.PATH ?? '', ONLY_THIS: '1' } });
    // Print variable names only: a developer PATH can exceed maxOutputBytes and truncate the output.
    const script =
      'console.log(JSON.stringify({ cwd: process.cwd(), names: Object.keys(process.env), onlyThis: process.env.ONLY_THIS }))';
    const result = await runCommand(nodeScript(script), opts);
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      error: null,
      stderr: '',
    });
    const parsed = JSON.parse(result.stdout) as { cwd: string; names: string[]; onlyThis: string };
    expect(parsed.cwd).toBe(realpathSync(opts.cwd));
    // Only the explicit environment reaches the child; nothing is inherited from the parent.
    const names = parsed.names.filter((name) => !OS_INJECTED_ENV.includes(name));
    expect(names.sort()).toEqual(['ONLY_THIS', 'PATH']);
    expect(parsed.onlyThis).toBe('1');
    expect(result.command).toEqual(nodeScript(script));
  });

  it('rejects an empty command without spawning anything', async () => {
    expect(await runCommand([], options())).toEqual({
      command: [],
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      error: 'empty command',
      strayProcesses: false,
    });
  });

  it('does not start a command when the run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const dir = tmp('not-started');
    const result = await runCommand(
      nodeScript(`require('fs').writeFileSync(${JSON.stringify(`${dir}/started`)}, '1')`),
      options({ signal: controller.signal }),
    );
    expect(result).toMatchObject({ cancelled: true, exitCode: null, durationMs: 0, error: null });
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${dir}/started`)).toBe(false);
  });

  it('captures stderr separately and reports the exit code', async () => {
    const result = await runCommand(
      nodeScript('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'),
      options(),
    );
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err', signal: null });
  });

  it('redacts secrets from captured output', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const result = await runCommand(
      nodeScript(`console.log("token=${token}"); console.error("${token}")`),
      options(),
    );
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).not.toContain(token);
  });

  it('truncates output across chunks and counts every dropped byte (FR-110-44)', async () => {
    const result = await runCommand(
      nodeScript(
        'process.stdout.write("a".repeat(1000)); setTimeout(() => { process.stdout.write("b".repeat(100)); setTimeout(() => process.stdout.write("c".repeat(50)), 50); }, 50)',
      ),
      options({ maxOutputBytes: 1024 }),
    );
    expect(result.truncated).toBe(true);
    // 1000 + 24 bytes kept; 76 bytes of the second chunk and the whole third chunk dropped.
    expect(result.stdout).toBe(
      `${'a'.repeat(1000)}${'b'.repeat(24)}\n[truncated ${76 + 50} bytes]`,
    );
    expect(result.stderr).toBe('');
  });

  it('marks truncation when only stderr overflows', async () => {
    const result = await runCommand(
      nodeScript('process.stderr.write("e".repeat(2000))'),
      options({ maxOutputBytes: 1024 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stderr).toMatch(/\[truncated 976 bytes\]$/);
  });

  posixOnly('cancels a running command with SIGTERM', async () => {
    const controller = new AbortController();
    const pending = runCommand(nodeScript('setInterval(() => {}, 1000)'), {
      ...options(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result).toMatchObject({ cancelled: true, timedOut: false, signal: 'SIGTERM' });
    expect(result.durationMs).toBeLessThan(DEFAULT_KILL_GRACE_MS);
  });

  posixOnly(
    'kills the whole process group, including grandchildren, on timeout',
    async () => {
      // The grandchild inherits stdout; if only the direct child were killed, the pipe would stay
      // open and the command would not finish until the grandchild exits after 30 s.
      const result = await runCommand(
        nodeScript(
          "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)",
        ),
        options({ timeoutMs: 300 }),
      );
      expect(result).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
      expect(result.durationMs).toBeLessThan(10_000);
    },
    20_000,
  );

  posixOnly('reports timeout and cancellation when cancelled during the grace period', async () => {
    const controller = new AbortController();
    // sh ignores SIGTERM within a millisecond of starting; a Node.js script installs its handler
    // only after its start-up, which took more than the 100 ms timeout on a loaded CI runner.
    const pending = runCommand(['sh', '-c', "trap '' TERM; while :; do sleep 1; done"], {
      ...options(),
      timeoutMs: 100,
      killGraceMs: 800,
      signal: controller.signal,
    });
    // Cancelling during the grace period must not skip it: SIGKILL still waits for killGraceMs.
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result).toMatchObject({ timedOut: true, cancelled: true, signal: 'SIGKILL' });
    expect(result.durationMs).toBeGreaterThanOrEqual(850);
  });

  posixOnly(
    'kills a background child a command leaves behind when it exits (SPEC-118 §12)',
    async () => {
      // The child closed its output, so nothing but the process group ties it to the command.
      const result = await runCommand(
        ['sh', '-c', 'sleep 600 > /dev/null 2>&1 < /dev/null & echo $!'],
        options(),
      );
      const child = Number(result.stdout.trim());
      expect(result).toMatchObject({ exitCode: 0, strayProcesses: false, timedOut: false });
      expect(() => process.kill(child, 0)).toThrow(/ESRCH/);
    },
  );

  posixOnly(
    'ends when the command exits although a background child holds its output',
    async () => {
      const result = await runCommand(['sh', '-c', 'sleep 600 & echo started'], options());
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'started\n' });
      expect(result.durationMs).toBeLessThan(5000);
    },
  );

  posixOnly(
    'reports a process that left the group and holds the output as stray, after the drain period',
    async () => {
      // `setsid` escapes the group kill; before, `close` never came and even the timeout could not
      // end the command, because its group was already empty.
      const result = await runCommand(
        [
          'sh',
          '-c',
          'setsid sh -c "echo \\$\\$ > esc.pid; exec sleep 600" & while [ ! -s esc.pid ]; do sleep 0.01; done; cat esc.pid',
        ],
        {
          ...options(),
          timeoutMs: 60_000,
        },
      );
      const escaped = Number(result.stdout.trim());
      try {
        expect(result).toMatchObject({ exitCode: 0, strayProcesses: true, timedOut: false });
        expect(result.durationMs).toBeLessThan(30_000);
      } finally {
        process.kill(escaped, 'SIGKILL');
      }
    },
    60_000,
  );

  it('handles cancellation of a command whose executable could not be started', async () => {
    const controller = new AbortController();
    const pending = runCommand(['definitely-not-a-command-xyz'], {
      ...options(),
      signal: controller.signal,
    });
    // Abort synchronously: the spawn failed, so there is no pid to signal.
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('terminates the direct child where process groups are unavailable (Windows path)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    let pending: ReturnType<typeof runCommand>;
    // runCommand reads the platform synchronously before spawning; restore it right after.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      pending = runCommand(nodeScript('setInterval(() => {}, 1000)'), options({ timeoutMs: 200 }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    const result = await pending;
    expect(result).toMatchObject({ timedOut: true, cancelled: false, exitCode: null });
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM');
  });
});
