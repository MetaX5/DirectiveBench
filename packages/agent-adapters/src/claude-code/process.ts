import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  killProcessGroup,
  PROCESS_KILL_CONFIRM_MS,
  PROCESS_OUTPUT_DRAIN_MS,
  signalProcessGroup,
  usesProcessGroups,
} from '../process-group';

/**
 * Time between SIGTERM and SIGKILL when a `claude` run times out or is cancelled (SPEC-203 §5,
 * SPEC-110 FR-110-08). With the wait for the killed group this keeps AC-10 — no `claude` process
 * left 10 s after Ctrl-C, even when it ignores SIGINT and SIGTERM.
 */
export const CLAUDE_KILL_GRACE_MS = 5000;

/**
 * Most stdout bytes kept from one `claude` run. A `stream-json` transcript holds every message and
 * tool result of the session; a run that writes more is stopped (`outputLimitExceeded`), so a
 * runaway session cannot exhaust the runner's memory.
 */
export const CLAUDE_STDOUT_MAX_BYTES = 32 * 1024 * 1024;

/** Most stderr bytes kept: the last ones, where the CLI's diagnostics end up. */
export const CLAUDE_STDERR_MAX_BYTES = 64 * 1024;

export interface ClaudeProcessInput {
  /** Absolute path of the `claude` executable (found on `PATH` without a shell). */
  executable: string;
  /** The argv without the executable (`buildClaudeArgv`); never contains the prompt. */
  argv: readonly string[];
  /** The complete child environment (`buildClaudeEnv`); nothing else is inherited. */
  env: Record<string, string>;
  /** Working directory: the pinned workspace's canonical path. */
  cwd: string;
  /** Written to stdin, which is then closed (SPEC-203 §5: no prompt in argv). */
  prompt: string;
  timeoutMs: number;
  /**
   * Cancels the run. An abort whose reason is a `TimeoutError` (the engine's agent timeout)
   * counts as a timeout, any other as a cancellation.
   */
  signal: AbortSignal;
  /** Overrides {@link CLAUDE_KILL_GRACE_MS} (tests). */
  killGraceMs?: number;
}

/**
 * What one `claude` process did. Output is raw and unredacted: `lines` are the input of the
 * stream parser, which redacts what it keeps; nothing here may be persisted or logged as is.
 */
export interface ClaudeProcessResult {
  /** Whether a process was started (false: `error` says why the spawn failed). */
  spawned: boolean;
  /**
   * stdout split at line feeds (a trailing `\r` removed), in order, including a final line
   * without a line feed. When the output limit was hit, the incomplete last line is dropped.
   */
  lines: string[];
  /** The last {@link CLAUDE_STDERR_MAX_BYTES} of stderr. */
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  /** The signal that ended `claude`, e.g. `SIGTERM` after a timeout. */
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** stdout exceeded {@link CLAUDE_STDOUT_MAX_BYTES}; the run was stopped. */
  outputLimitExceeded: boolean;
  /**
   * Members of `claude`'s process group were still alive after it was killed (POSIX), or a
   * process outside the group still held its output after {@link PROCESS_OUTPUT_DRAIN_MS}.
   */
  strayProcesses: boolean;
  /** Spawn failure (`ENOENT`, `EACCES`) or another error of the child process. */
  error: string | null;
  /** Writing the prompt failed, e.g. `EPIPE` when `claude` exited without reading stdin. */
  stdinError: string | null;
  durationMs: number;
}

/** Whether an aborted signal was aborted by a timeout (`TimeoutError` reason). */
export function abortedByTimeout(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

/** Splits a byte stream into lines; bytes are decoded per complete line (UTF-8 safe). */
class LineCollector {
  readonly lines: string[] = [];
  private partial: Buffer[] = [];
  private bytes = 0;
  limitExceeded = false;

  /** Adds a chunk; returns false once the stream exceeded the limit (nothing more is kept). */
  push(chunk: Buffer): boolean {
    if (this.limitExceeded) return false;
    this.bytes += chunk.length;
    if (this.bytes > CLAUDE_STDOUT_MAX_BYTES) {
      this.limitExceeded = true;
      this.partial = [];
      return false;
    }
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      this.partial.push(chunk.subarray(start, newline));
      this.flush();
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
    return true;
  }

  /** Ends the stream: a final line without a line feed is kept. */
  end(): void {
    if (this.partial.length > 0) this.flush();
  }

  private flush(): void {
    const line = Buffer.concat(this.partial).toString('utf8');
    this.partial = [];
    this.lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
}

/** Keeps the last `limit` bytes of a stream. */
class TailBuffer {
  private buffer = Buffer.alloc(0);
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.limit) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.limit);
      this.truncated = true;
    }
  }

  toString(): string {
    return this.buffer.toString('utf8');
  }
}

/**
 * Runs one `claude` process: argv only (no shell), the given environment, the prompt on stdin,
 * in its own process group (POSIX). On timeout, cancellation or output over the limit the group
 * receives SIGTERM and, after the grace period, SIGKILL. Whenever `claude` exits, whatever is left
 * in its group (background tool processes included) is killed and awaited before the result is
 * returned; output pipes held by a process that left the group are closed after
 * {@link PROCESS_OUTPUT_DRAIN_MS} and reported as `strayProcesses`. Never rejects.
 *
 * Windows has no process groups: only `claude` itself is signalled (best effort, NFR-118-04).
 * Throws only for a relative `executable` (a programming error: it would resolve against `cwd`).
 */
export function runClaudeProcess(input: ClaudeProcessInput): Promise<ClaudeProcessResult> {
  if (!isAbsolute(input.executable)) {
    throw new Error('The claude executable must be an absolute path.');
  }
  const started = performance.now();
  const stdout = new LineCollector();
  const stderr = new TailBuffer(CLAUDE_STDERR_MAX_BYTES);
  let timedOut = false;
  let cancelled = false;
  let error: string | null = null;
  let stdinError: string | null = null;
  const result = (
    child: ChildProcess | null,
    exitCode: number | null,
    signal: string | null,
    gone: boolean,
  ): ClaudeProcessResult => ({
    spawned: child?.pid !== undefined,
    lines: stdout.lines,
    stderr: stderr.toString(),
    stderrTruncated: stderr.truncated,
    // A failed spawn reports the negative errno as its "exit code"; there was no exit.
    exitCode: child?.pid === undefined ? null : exitCode,
    signal,
    timedOut,
    cancelled,
    outputLimitExceeded: stdout.limitExceeded,
    strayProcesses: !gone,
    error,
    stdinError,
    durationMs: Math.round(performance.now() - started),
  });

  if (input.signal.aborted) {
    if (abortedByTimeout(input.signal)) timedOut = true;
    else cancelled = true;
    return Promise.resolve(result(null, null, null, true));
  }

  const groups = usesProcessGroups();
  let child: ChildProcess;
  try {
    child = spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      // Next.js augments `ProcessEnv` with a required `NODE_ENV`; the allowlisted record is
      // widened to the option's type here (lesson 2026-10-22).
      env: input.env as NodeJS.ProcessEnv,
      shell: false,
      detached: groups,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (spawnError) {
    // Invalid arguments (e.g. a NUL byte in the environment) throw before any process exists.
    // Only the code: Node's message quotes the offending argument, e.g. an environment value.
    error = `spawn failed (${String((spawnError as NodeJS.ErrnoException).code)})`;
    return Promise.resolve(result(null, null, null, true));
  }

  return new Promise((resolve) => {
    let forceKillTimer: NodeJS.Timeout | undefined;
    let confirmTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let settled = false;
    // Set once `claude` exited: from then on no signal is sent to its (possibly reused) id.
    let exited = false;
    let drained = false;
    let groupGone: Promise<boolean> = Promise.resolve(true);

    const terminate = () => {
      if (forceKillTimer || exited) return;
      signalProcessGroup(child, groups, 'SIGTERM');
      // Cleared when `claude` exits, so it never signals a group id that may be reused.
      forceKillTimer = setTimeout(() => {
        signalProcessGroup(child, groups, 'SIGKILL');
        // A `claude` that still does not exit (the signal was refused, EPERM, or it hangs in the
        // kernel) is given up after a bound instead of keeping the run pending forever.
        confirmTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null, null, false);
        }, PROCESS_KILL_CONFIRM_MS);
      }, input.killGraceMs ?? CLAUDE_KILL_GRACE_MS);
    };
    const finish = (code: number | null, signal: string | null, gone: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(confirmTimer);
      clearTimeout(drainTimer);
      input.signal.removeEventListener('abort', onAbort);
      stdout.end();
      resolve(result(child, code, signal, gone));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const onAbort = () => {
      if (abortedByTimeout(input.signal)) timedOut = true;
      else cancelled = true;
      terminate();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!stdout.push(chunk)) terminate();
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin?.on('error', (stdinFailure: Error) => {
      stdinError = stdinFailure.message;
    });
    child.stdin?.end(input.prompt);
    child.on('error', (childError: Error) => {
      error = childError.message;
    });
    child.on('exit', () => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(confirmTimer);
      input.signal.removeEventListener('abort', onAbort);
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
      finish(code, signal, gone && !drained);
    });
  });
}
