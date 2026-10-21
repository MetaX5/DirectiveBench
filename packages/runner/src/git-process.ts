import { spawn } from 'node:child_process';
import { redactSecrets } from '@directivebench/core';

/** git's error output is a few lines; more is cut off before it is redacted and kept. */
export const GIT_MAX_STDERR_BYTES = 64 * 1024;

export interface GitProcessOptions {
  /** Working directory: DirectiveBench's own cache or data directory, never repository content. */
  cwd: string;
  /** Complete environment for git. Nothing is inherited. */
  env: Record<string, string>;
  /** Written to git's standard input, which is then closed; none when absent. */
  stdin?: Buffer;
  timeoutMs: number;
  /** More standard output than this kills git; the result says so (`outputExceeded`). */
  maxStdoutBytes: number;
  signal: AbortSignal;
  /** Time between SIGTERM and SIGKILL on timeout, cancellation or a limit. */
  killGraceMs: number;
  /** Exact values (proxy URLs) redacted from the error output besides the token shapes. */
  knownSecrets: readonly string[];
  /** Checked every `intervalMs` while git runs; git is killed as soon as it returns true. */
  watch?: { intervalMs: number; exceeded: () => Promise<boolean> };
}

export interface GitProcessResult {
  exitCode: number | null;
  /** Raw bytes, never redacted or decoded: file contents and paths must stay exact. */
  stdout: Buffer;
  /** Redacted error output, at most {@link GIT_MAX_STDERR_BYTES}. */
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  /** The `watch` check fired (e.g. the cache grew beyond its limit). */
  watchTriggered: boolean;
  /** git could not be started or fed (spawn or standard-input error). */
  error: string | null;
}

/**
 * An error's errno-style code (`ENOENT`, `EACCES`, …) to name in a message, or `unknown error`;
 * never the error's own text, which names absolute paths.
 */
export function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'unknown error';
}

/**
 * Runs git with an argv array and no shell, its output kept as raw bytes. Unlike `runCommand`
 * (benchmark-engine), standard output is never redacted — a redacted path or blob would be stored
 * wrong (lessons, 2026-10-19) — and it is bounded by killing git rather than truncating. Standard
 * error is bounded and redacted. On timeout, cancellation, a full output or a fired `watch`, the
 * whole process group (POSIX) gets SIGTERM and, after the grace period, SIGKILL.
 */
export function runGitProcess(
  git: string,
  args: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  const result: Omit<GitProcessResult, 'stdout' | 'stderr' | 'exitCode'> = {
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    watchTriggered: false,
    error: null,
  };
  if (options.signal.aborted) {
    return Promise.resolve({
      ...result,
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: '',
      cancelled: true,
    });
  }
  const detached = process.platform !== 'win32';
  const child = spawn(git, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;
    let watchTimer: NodeJS.Timeout | undefined;

    const sendSignal = (signal: NodeJS.Signals) => {
      // No pid: git never started (its `error` event follows), so there is nothing to signal.
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process group is already gone: nothing left to stop.
      }
    };
    const terminate = () => {
      if (forceKill) return;
      sendSignal('SIGTERM');
      forceKill = setTimeout(() => sendSignal('SIGKILL'), options.killGraceMs);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      result.cancelled = true;
      terminate();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const { watch } = options;
    if (watch) {
      const check = () => {
        watchTimer = setTimeout(() => {
          void watch.exceeded().then(
            (exceeded) => {
              if (closed) return;
              if (exceeded) {
                result.watchTriggered = true;
                terminate();
              } else check();
            },
            // A check that cannot run cannot vouch for the limit: stop git (fail closed).
            (error: unknown) => {
              if (closed) return;
              result.error ??= `The running check failed (${errnoCode(error)}).`;
              result.watchTriggered = true;
              terminate();
            },
          );
        }, watch.intervalMs);
      };
      check();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > options.maxStdoutBytes) {
        result.outputExceeded = true;
        terminate();
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const room = GIT_MAX_STDERR_BYTES - stderrBytes;
      if (room <= 0) return;
      stderr.push(chunk.subarray(0, room));
      stderrBytes += Math.min(room, chunk.length);
    });
    // Not the message: it names git's absolute path (`spawn /usr/bin/git ENOENT`), and a working
    // directory that is missing or not accessible is reported the same way.
    child.on('error', (error: Error) => {
      result.error = `git could not be started (${errnoCode(error)}).`;
    });
    if (options.stdin && child.stdin) {
      // git may exit before reading everything (e.g. it rejects its arguments); its exit status
      // reports that, so a broken pipe is recorded rather than thrown.
      child.stdin.on('error', (error: Error) => {
        result.error ??= `git's input could not be written (${errnoCode(error)}).`;
      });
      child.stdin.end(options.stdin);
    }
    child.on('close', (code: number | null) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      clearTimeout(watchTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        ...result,
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: redactSecrets(Buffer.concat(stderr).toString('utf8'), options.knownSecrets),
      });
    });
  });
}
