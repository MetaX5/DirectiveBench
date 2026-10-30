import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A fake `claude` executable for process-control tests (SPEC-203 §11): a POSIX `sh` script on a
 * test `PATH`. It answers `--version` and `auth status` like the CLI; in print mode it records the
 * invocation (argv, environment, working directory, stdin) in its own directory and then behaves
 * as the chosen mode says. Modes that ignore signals install `trap '' INT TERM` as their first
 * command, so the state exists before any test timer can fire (lesson 2026-10-21).
 */
export type FakeClaudeMode =
  /** Reads the prompt, writes a short NDJSON stream (last line without a line feed), exits 0. */
  | 'stream'
  /** Ignores SIGINT and SIGTERM, starts a background `sleep` that does too, and never ends. */
  | 'hang'
  /** Writes a result line and exits 0, leaving a background child that closed its output. */
  | 'leave-child'
  /** Exits 0 but leaves a process in a new session (`setsid()`) that holds stdout open. */
  | 'escape-session'
  /** Writes 64 KiB lines of `x` to stdout without end. */
  | 'flood'
  /** Writes 200 000 bytes to stderr and exits 3. */
  | 'stderr-flood'
  /** Exits at once without reading stdin. */
  | 'no-read'
  /**
   * Reads the prompt, writes the stream set with {@link FakeClaude.setStream} (a recorded
   * fixture), then sleeps for the set delay (seconds; signals end it) and exits with the set code.
   */
  | 'replay';

export interface FakeClaude {
  /** Directory holding the script (`claude`) — put it on `PATH`. */
  binDir: string;
  /** Absolute path of the script. */
  executable: string;
  /** Whether print mode was ever started. */
  invoked(): boolean;
  /** The recorded argv lines (one argument per line). */
  argv(): string[];
  /** The recorded environment (`env` output: NAME=value lines). */
  env(): Record<string, string>;
  cwd(): string;
  stdin(): string;
  /** Pid of the fake (the process-group leader), once it is running. */
  pid(): number | null;
  /** Pid of the background child of `hang`, `leave-child` and `escape-session`. */
  childPid(): number | null;
  /** `replay`: the stream to write, the exit code and the delay after the stream (seconds). */
  setStream(stream: string, options?: { exitCode?: number; delaySeconds?: number }): void;
}

export interface FakeClaudeOptions {
  /** The `--version` line (default `2.1.296 (Claude Code)`). */
  version?: string;
}

const NDJSON = [
  '{"type":"system","subtype":"init","model":"claude-test-model","tools":["Edit","Skill"]}',
  // Out-of-workspace edit denied under dontAsk (FR-118-07): recorded raw for the stream parser.
  '{"type":"result","subtype":"success","is_error":false,"permission_denials":[{"tool_name":"Edit","tool_input":{"file_path":"/etc/outside.txt"}}]}',
];

function body(mode: FakeClaudeMode, dir: string): string {
  const q = (name: string) => `'${join(dir, name)}'`;
  switch (mode) {
    case 'stream':
      return [
        `cat > ${q('stdin.txt')}`,
        `printf '%s\\n' '${NDJSON[0]}'`,
        // A CRLF line, then a final line without a line feed.
        `printf '%s\\r\\n' '{"type":"assistant","message":{"model":"claude-test-model"}}'`,
        `printf '%s' '${NDJSON[1]}'`,
        'echo diagnostics >&2',
        'exit 0',
      ].join('\n');
    case 'hang':
      return [
        `sleep 600 &`,
        `echo $! > ${q('child.pid')}`,
        `echo $$ > ${q('pid')}`,
        'while :; do sleep 1; done',
      ].join('\n');
    case 'leave-child':
      return [
        `cat > ${q('stdin.txt')}`,
        `sleep 600 > /dev/null 2>&1 < /dev/null &`,
        `echo $! > ${q('child.pid')}`,
        `echo $$ > ${q('pid')}`,
        `printf '%s\\n' '${NDJSON[1]}'`,
        'exit 0',
      ].join('\n');
    case 'escape-session':
      return [
        `cat > ${q('stdin.txt')}`,
        // The escapee writes its pid only after `setsid`; wait for it, or the group kill could
        // reach it before it left the group.
        // macOS has no `setsid` command; Perl's POSIX::setsid runs on Linux and macOS (issue #120).
        `perl -MPOSIX -e 'setsid() >= 0 or die; exec @ARGV' sh -c 'echo $$ > ${join(dir, 'child.pid')}; exec sleep 600' &`,
        `while [ ! -s ${q('child.pid')} ]; do sleep 0.01; done`,
        `echo $$ > ${q('pid')}`,
        `printf '%s\\n' '${NDJSON[1]}'`,
        'exit 0',
      ].join('\n');
    case 'flood':
      // Long lines keep the line count small while the bytes pass the limit quickly.
      return `echo $$ > ${q('pid')}\nexec yes "$(head -c 65536 /dev/zero | tr '\\000' x)"`;
    case 'stderr-flood':
      return `cat > /dev/null\nhead -c 200000 /dev/zero | tr '\\000' e >&2\nexit 3`;
    case 'no-read':
      return 'exit 0';
    case 'replay':
      return [
        `cat > ${q('stdin.txt')}`,
        `cat ${q('stream.ndjson')}`,
        `sleep "$(cat ${q('delay')})"`,
        `exit "$(cat ${q('exit-code')})"`,
      ].join('\n');
  }
}

/** Writes a fake `claude` into `root/bin` (and its records into `root/records`). */
export function writeFakeClaude(
  root: string,
  mode: FakeClaudeMode,
  options: FakeClaudeOptions = {},
): FakeClaude {
  const binDir = join(root, 'bin');
  const records = join(root, 'records');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(records, { recursive: true });
  const executable = join(binDir, 'claude');
  const q = (name: string) => `'${join(records, name)}'`;
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      "trap '' INT TERM",
      'case "$1" in',
      `  --version) echo '${options.version ?? '2.1.296 (Claude Code)'}'; exit 0 ;;`,
      '  auth) echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0 ;;',
      // The readiness probe: `--setting-sources project,local auth status --json`.
      '  --setting-sources) echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0 ;;',
      'esac',
      // Signals are ignored only where the mode says so.
      ...(mode === 'hang' ? [] : ['trap - INT TERM']),
      `: > ${q('invoked')}`,
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > ${q('argv.txt')}`,
      `env > ${q('env.txt')}`,
      `pwd -P > ${q('cwd.txt')}`,
      body(mode, records),
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  const setStream: FakeClaude['setStream'] = (stream, streamOptions = {}) => {
    writeFileSync(join(records, 'stream.ndjson'), stream);
    writeFileSync(join(records, 'exit-code'), String(streamOptions.exitCode ?? 0));
    writeFileSync(join(records, 'delay'), String(streamOptions.delaySeconds ?? 0));
  };
  if (mode === 'replay') setStream('');
  const read = (name: string) => readFileSync(join(records, name), 'utf8');
  // A pid file being written reads empty: 0 is "not yet".
  const pidOf = (name: string) =>
    existsSync(join(records, name)) ? Number(read(name).trim()) || null : null;
  return {
    binDir,
    executable,
    invoked: () => existsSync(join(records, 'invoked')),
    argv: () => read('argv.txt').split('\n').slice(0, -1),
    env: () =>
      Object.fromEntries(
        read('env.txt')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      ),
    cwd: () => read('cwd.txt').trim(),
    stdin: () => read('stdin.txt'),
    pid: () => pidOf('pid'),
    childPid: () => pidOf('child.pid'),
    setStream,
  };
}

/** Whether a process (or, for a negative id, a process group) exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Resolves once `read()` returns a value (a readiness signal), polling every 10 ms. */
export async function waitFor<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the fake claude');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
