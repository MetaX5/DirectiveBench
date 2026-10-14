import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '@directivebench/core';

export interface CommandOptions {
  cwd: string;
  /** Complete environment for the child. Nothing is inherited implicitly. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

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
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    if (slice.length < chunk.length) this.truncated = true;
    this.chunks.push(slice);
    this.size += slice.length;
  }
  toString(): string {
    return redactSecrets(Buffer.concat(this.chunks).toString('utf8'));
  }
}

/**
 * Runs an argv command without a shell. On timeout or cancellation the whole process group is
 * killed (POSIX). Output is truncated and secret-redacted before it is returned.
 */
export function runCommand(
  command: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const [executable, ...args] = command;
  const started = performance.now();
  const stdout = new OutputBuffer(options.maxOutputBytes);
  const stderr = new OutputBuffer(options.maxOutputBytes);
  const base = { command: [...command], stdout: '', stderr: '', truncated: false };

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
    const detached = process.platform !== 'win32';
    const child: ChildProcess = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;

    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: Error) => {
      spawnError = error.message;
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
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
      });
    });
  });
}
