import { spawn, type ChildProcess } from 'node:child_process';
import {
  killProcessGroup,
  PROCESS_KILL_CONFIRM_MS,
  PROCESS_OUTPUT_DRAIN_MS,
  signalProcessGroup,
  usesProcessGroups,
} from '@directivebench/agent-adapters';
import { redactSecrets } from '@directivebench/core';

export interface CommandOptions {
  cwd: string;
  /** Complete environment for the child. Nothing is inherited implicitly. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  /** Time between SIGTERM and SIGKILL on timeout or cancellation (default 5 s, FR-110-08). */
  killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 5000;

export interface CommandResult {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Spawn failure, e.g. executable not found. */
  error: string | null;
  /**
   * True when processes the command started were still alive after the command ended and its
   * process group was killed (see {@link runCommand}); the workspace may still change.
   */
  strayProcesses: boolean;
}

const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'PATHEXT', 'COMSPEC'];

/**
 * Minimal environment for benchmark commands: no inherited secrets, HOME and temp directories
 * pointed at per-run locations so tools do not read the user's dotfiles or credentials.
 */
export function buildCommandEnv(
  homeDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.TMPDIR = homeDir;
  env.TEMP = homeDir;
  env.TMP = homeDir;
  env.CI = 'true';
  env.NO_COLOR = '1';
  return env;
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      this.dropped += chunk.length;
      return;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    if (slice.length < chunk.length) {
      this.truncated = true;
      this.dropped += chunk.length - slice.length;
    }
    this.chunks.push(slice);
    this.size += slice.length;
  }
  toString(): string {
    const text = redactSecrets(Buffer.concat(this.chunks).toString('utf8'));
    // FR-110-44: excess output is dropped and marked.
    return this.dropped > 0 ? `${text}\n[truncated ${this.dropped} bytes]` : text;
  }
}

/**
 * Runs an argv command without a shell. On timeout or cancellation the whole process group
 * (POSIX) receives SIGTERM and, if still alive after the grace period, SIGKILL. When the command
 * itself exits, whatever it left running in its group — a backgrounded child, even one that closed
 * its output — is killed and awaited before the result is returned, so nothing a `setup` command
 * started can change the workspace after it (SPEC-118 §12); `strayProcesses` reports a group that
 * would not go away. Output is truncated and secret-redacted before it is returned.
 */
export function runCommand(
  command: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const [executable, ...args] = command;
  const started = performance.now();
  const stdout = new OutputBuffer(options.maxOutputBytes);
  const stderr = new OutputBuffer(options.maxOutputBytes);
  const base = {
    command: [...command],
    stdout: '',
    stderr: '',
    truncated: false,
    strayProcesses: false,
  };

  return new Promise((resolve) => {
    if (!executable) {
      resolve({
        ...base,
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        error: 'empty command',
      });
      return;
    }
    if (options.signal.aborted) {
      resolve({
        ...base,
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        durationMs: 0,
        error: null,
      });
      return;
    }
    const groups = usesProcessGroups();
    const child: ChildProcess = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: groups,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;

    let forceKillTimer: NodeJS.Timeout | undefined;
    let confirmTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let settled = false;
    // Set when a process outside the group still held the output pipes after the drain period.
    let drained = false;
    // Resolves to whether the group is gone; settled when the command exits (or never started).
    let groupGone: Promise<boolean> = Promise.resolve(true);
    // The leader's exit clears the timers and removes the abort listener, so no signal is ever
    // sent to its group id after that (the id may be reused once the group is gone).
    const sendSignal = (signal: NodeJS.Signals) => signalProcessGroup(child, groups, signal);
    const terminate = () => {
      if (forceKillTimer) return;
      sendSignal('SIGTERM');
      forceKillTimer = setTimeout(() => {
        sendSignal('SIGKILL');
        // A leader that still does not exit (the signal was refused, EPERM, or it hangs in the
        // kernel) is given up after a bound instead of keeping the run pending forever.
        confirmTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null, null, true);
        }, PROCESS_KILL_CONFIRM_MS);
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    const finish = (code: number | null, signal: string | null, stray: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(confirmTimer);
      clearTimeout(drainTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        command: [...command],
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        error: spawnError,
        strayProcesses: stray,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: Error) => {
      spawnError = error.message;
    });
    // The leader exited: kill what it left in its group. This also closes output pipes a
    // background child inherited, so `close` follows instead of waiting for the timeout. A
    // process that left the group (or, on Windows, any background child) can hold them forever:
    // after the drain period they are closed and it is reported as a stray process.
    child.on('exit', () => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(confirmTimer);
      options.signal.removeEventListener('abort', onAbort);
      groupGone = killProcessGroup(child, groups);
      drainTimer = setTimeout(() => {
        drained = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PROCESS_OUTPUT_DRAIN_MS);
    });
    child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(drainTimer);
      const gone = await groupGone;
      finish(code, signal, !gone || drained);
    });
  });
}
