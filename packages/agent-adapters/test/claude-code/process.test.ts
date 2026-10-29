import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeArgv,
  buildClaudeEnv,
  CLAUDE_KILL_GRACE_MS,
  CLAUDE_STDERR_MAX_BYTES,
  CLAUDE_STDOUT_MAX_BYTES,
  claudeProcessEnd,
  runClaudeProcess,
  type ClaudeProcessInput,
} from '../../src/claude-code';
import { findExecutable } from '../../src/probe';
import { PROCESS_KILL_CONFIRM_MS } from '../../src/process-group';
import { alive, waitFor, writeFakeClaude, type FakeClaudeMode } from './fake-claude';

const posix = describe.skipIf(process.platform === 'win32');

const roots: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
  // A test that failed half-way must not leave a sleeping fake behind.
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: the expected case.
    }
  }
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(mode: FakeClaudeMode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-process-')));
  roots.push(root);
  const fake = writeFakeClaude(root, mode);
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  for (const dir of [workspace, home, temp]) mkdirSync(dir);
  const env = buildClaudeEnv({
    authMode: 'subscription',
    baseEnv: {
      PATH: `${fake.binDir}:/usr/bin:/bin`,
      HOME: home,
      LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-must-not-reach-the-child',
      CLAUDE_CODE_OAUTH_TOKEN: 'token-must-not-reach-the-child',
    },
    tempDir: temp,
  });
  const input = (overrides: Partial<ClaudeProcessInput> = {}): ClaudeProcessInput => ({
    executable: fake.executable,
    argv: buildClaudeArgv({
      authMode: 'subscription',
      permissionProfile: 'edit-only',
      artifact: { format: 'skill-md', skillName: 'pdf' },
      model: null,
    }),
    env,
    cwd: workspace,
    prompt: 'Write the estimate.\nZażółć gęślą jaźń — 🚀\n',
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
  });
  return { fake, workspace, env, input };
}

/** Registers the fake's pids for clean-up once they exist. */
function track(...pids: (number | null)[]): void {
  for (const pid of pids) if (pid !== null) leftovers.push(pid);
}

posix('runClaudeProcess with a fake claude on PATH', () => {
  it('finds the fake on a test PATH like the readiness check does', async () => {
    const { fake, env } = setup('stream');
    expect(await findExecutable('claude', env)).toBe(fake.executable);
  });

  it('passes the prompt on stdin, the argv without it, the env and the workspace as cwd', async () => {
    const { fake, workspace, env, input } = setup('stream');
    const request = input();
    const result = await runClaudeProcess(request);

    expect(fake.stdin()).toBe(request.prompt);
    expect(fake.argv()).toEqual(request.argv);
    expect(fake.argv().join('\n')).not.toContain('Write the estimate');
    expect(fake.cwd()).toBe(workspace);
    // Nothing beyond the built environment reaches the child (the shell adds only PWD/SHLVL/_).
    const recorded = fake.env();
    for (const [name, value] of Object.entries(env)) expect(recorded[name]).toBe(value);
    expect(
      Object.keys(recorded).filter(
        (name) => !(name in env) && !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name),
      ),
    ).toEqual([]);
    expect(JSON.stringify(recorded)).not.toMatch(/must-not-reach/);

    expect(result).toMatchObject({
      spawned: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false,
      strayProcesses: false,
      error: null,
      stdinError: null,
      stderr: 'diagnostics\n',
      stderrTruncated: false,
    });
    // Raw lines for the stream parser: CRLF stripped, last line without a line feed kept, and the
    // out-of-workspace edit denial (FR-118-07) delivered untouched.
    expect(result.lines).toEqual([
      '{"type":"system","subtype":"init","model":"claude-test-model","tools":["Edit","Skill"]}',
      '{"type":"assistant","message":{"model":"claude-test-model"}}',
      '{"type":"result","subtype":"success","is_error":false,"permission_denials":[{"tool_name":"Edit","tool_input":{"file_path":"/etc/outside.txt"}}]}',
    ]);
    expect(JSON.parse(result.lines[2] as string).permission_denials[0].tool_input.file_path).toBe(
      '/etc/outside.txt',
    );
  });

  it('AC-10: after cancellation no process of the group remains within 10 s, though it ignores SIGINT and SIGTERM', async () => {
    const { fake, input } = setup('hang');
    const controller = new AbortController();
    const pending = runClaudeProcess(input({ signal: controller.signal }));
    const pid = await waitFor(() => fake.pid());
    const child = await waitFor(() => fake.childPid());
    track(pid, child);

    // Ctrl-C reaches the terminal's foreground group; even delivered to claude's own group it
    // changes nothing — the fake ignores it.
    process.kill(-pid, 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(true);

    const cancelledAt = performance.now();
    controller.abort();
    const result = await pending;
    const elapsed = performance.now() - cancelledAt;

    expect(result).toMatchObject({ cancelled: true, timedOut: false, signal: 'SIGKILL' });
    expect(result.strayProcesses).toBe(false);
    // SIGTERM is ignored, so SIGKILL follows after the named grace; all within 10 s.
    expect(elapsed).toBeGreaterThanOrEqual(CLAUDE_KILL_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(10_000);
    expect(alive(pid)).toBe(false);
    expect(alive(child)).toBe(false);
    expect(alive(-pid)).toBe(false);
  }, 30_000);

  it('gives up on a claude that cannot be killed (signals refused with EPERM) after a bound', async () => {
    const { fake, input } = setup('hang');
    const kill = process.kill.bind(process);
    const pipes = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'PipeWrap').length;
    const pipesBefore = pipes();
    // A prompt larger than the pipe buffer, which the hanging fake never reads. The timeout is
    // triggered only once the fake ignores SIGTERM and every signal is refused: a fixed 100 ms
    // timer raced the shell's start on macOS (issue #120).
    const controller = new AbortController();
    const pending = runClaudeProcess(
      input({
        signal: controller.signal,
        killGraceMs: 100,
        prompt: 'x'.repeat(4 * 1024 * 1024),
      }),
    );
    const pid = await waitFor(() => fake.pid());
    track(pid, await waitFor(() => fake.childPid()));
    const refuse = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    controller.abort(new DOMException('The agent run timed out', 'TimeoutError'));
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      refuse.mockRestore();
    }
    // No referenced pipe of the abandoned child is left (stdin with the queued prompt included),
    // so nothing keeps the CLI process alive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pipes()).toBeLessThanOrEqual(pipesBefore);
    kill(-pid, 'SIGKILL');
    expect(result).toMatchObject({ timedOut: true, exitCode: null, strayProcesses: true });
    expect(result.durationMs).toBeLessThan(PROCESS_KILL_CONFIRM_MS + 10_000);
    expect(claudeProcessEnd(result)?.errorCode).toBe('stray-processes');
  }, 30_000);

  it('escalates a timeout from SIGTERM to SIGKILL after the grace period', async () => {
    const { fake, input } = setup('hang');
    // Timed out once the fake ignores SIGTERM: a fixed timer raced the shell's start (issue #120).
    const controller = new AbortController();
    const pending = runClaudeProcess(input({ signal: controller.signal, killGraceMs: 300 }));
    await waitFor(() => fake.pid());
    controller.abort(new DOMException('The agent run timed out', 'TimeoutError'));
    const result = await pending;
    track(fake.pid(), fake.childPid());
    expect(result).toMatchObject({ timedOut: true, cancelled: false, signal: 'SIGKILL' });
    expect(result.durationMs).toBeGreaterThanOrEqual(290);
    expect(alive(-(fake.pid() as number))).toBe(false);
  });

  it('treats an abort with a TimeoutError reason as a timeout', async () => {
    const { fake, input } = setup('hang');
    const controller = new AbortController();
    const pending = runClaudeProcess(input({ signal: controller.signal, killGraceMs: 100 }));
    track(await waitFor(() => fake.pid()));
    controller.abort(new DOMException('The agent run timed out', 'TimeoutError'));
    expect(await pending).toMatchObject({ timedOut: true, cancelled: false });
  });

  it('does not start claude when the signal is already aborted', async () => {
    const { fake, input } = setup('stream');
    const cancelled = await runClaudeProcess(input({ signal: AbortSignal.abort() }));
    expect(cancelled).toMatchObject({ spawned: false, cancelled: true, timedOut: false });
    const controller = new AbortController();
    controller.abort(new DOMException('late', 'TimeoutError'));
    const timedOut = await runClaudeProcess(input({ signal: controller.signal }));
    expect(timedOut).toMatchObject({ spawned: false, cancelled: false, timedOut: true });
    expect(fake.invoked()).toBe(false);
  });

  it('kills a background child claude leaves behind when it exits', async () => {
    const { fake, input } = setup('leave-child');
    const result = await runClaudeProcess(input());
    const child = fake.childPid() as number;
    track(child);
    expect(result).toMatchObject({ exitCode: 0, strayProcesses: false });
    expect(result.lines).toHaveLength(1);
    expect(alive(child)).toBe(false);
  });

  it('closes output pipes a process outside the group holds, after the drain period', async () => {
    const { fake, input } = setup('escape-session');
    const result = await runClaudeProcess(input());
    const escaped = fake.childPid() as number;
    track(escaped);
    // `setsid` leaves the group, so it cannot be killed; the run still ends, and fails closed.
    expect(result).toMatchObject({ exitCode: 0, strayProcesses: true });
    expect(alive(escaped)).toBe(true);
    expect(result.lines).toHaveLength(1);
  });

  it('stops a run whose stdout exceeds the limit', async () => {
    const { fake, input } = setup('flood');
    const result = await runClaudeProcess(input({ killGraceMs: 200 }));
    track(fake.pid());
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    const kept = result.lines.reduce((sum, line) => sum + line.length + 1, 0);
    expect(kept).toBeLessThanOrEqual(CLAUDE_STDOUT_MAX_BYTES);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.every((line) => line === 'x'.repeat(65_536))).toBe(true);
  }, 30_000);

  it('keeps only the tail of stderr', async () => {
    const { input } = setup('stderr-flood');
    const result = await runClaudeProcess(input());
    expect(result.exitCode).toBe(3);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr).toBe('e'.repeat(CLAUDE_STDERR_MAX_BYTES));
  });

  it('records a prompt claude never read as a stdin error', async () => {
    const { input } = setup('no-read');
    const result = await runClaudeProcess(input({ prompt: 'x'.repeat(4 * 1024 * 1024) }));
    expect(result.exitCode).toBe(0);
    expect(result.stdinError).toMatch(/EPIPE/);
  });

  it('reports a spawn failure without starting anything', async () => {
    const { input, workspace } = setup('stream');
    const missing = await runClaudeProcess(input({ executable: join(workspace, 'no-claude') }));
    expect(missing).toMatchObject({ spawned: false, exitCode: null });
    expect(missing.error).toMatch(/ENOENT/);

    const notExecutable = join(workspace, 'claude');
    writeFileSync(notExecutable, '#!/bin/sh\n');
    const denied = await runClaudeProcess(input({ executable: notExecutable }));
    expect(denied.error).toMatch(/EACCES/);

    // Invalid arguments throw inside spawn before any process exists.
    const invalid = await runClaudeProcess(input({ env: { PATH: '/bin', HOME: 'a\0b' } }));
    expect(invalid).toMatchObject({ spawned: false });
    // Only the error code: Node's message would quote the environment value.
    expect(invalid.error).toBe('spawn failed (ERR_INVALID_ARG_VALUE)');
  });

  it('refuses a relative executable', () => {
    const { input } = setup('stream');
    expect(() => runClaudeProcess(input({ executable: 'claude' }))).toThrow(/absolute path/);
  });

  it('signals only claude itself where process groups are unavailable (Windows path)', async () => {
    const { fake, input } = setup('hang');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    let pending: ReturnType<typeof runClaudeProcess>;
    const controller = new AbortController();
    // The platform is read synchronously before the spawn; restore it right after.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      pending = runClaudeProcess(input({ signal: controller.signal, killGraceMs: 200 }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    // Timed out once the fake ignores SIGTERM: a fixed timer raced the shell's start (issue #120).
    await waitFor(() => fake.pid());
    controller.abort(new DOMException('The agent run timed out', 'TimeoutError'));
    const result = await pending;
    const child = fake.childPid();
    track(child);
    // Only the fake was killed; its background sleep survived and held the pipes until the drain.
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL', strayProcesses: true });
    expect(alive(child as number)).toBe(true);
  });
});
