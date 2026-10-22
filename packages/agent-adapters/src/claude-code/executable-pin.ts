import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  checkClaudeBinary,
  type ClaudeBinaryCheck,
  type ClaudeCodeTarget,
} from '../claude-code-readiness';
import { findExecutable } from '../probe';
import { errorCode } from '../workspace-pin';

/** Bytes read from the start of the executable to find a `#!` line. */
export const SHEBANG_MAX_BYTES = 256;

/** A file the pin checks before every agent run: how it is found, and what it was. */
export interface PinnedFile {
  /**
   * How the file is reached at spawn time: an absolute path, or — for an interpreter a
   * `#!/usr/bin/env <name>` line names — a command looked up on the child's `PATH`.
   */
  command: string;
  /** `realpath` when it was pinned. */
  canonical: string;
  /** `dev:ino:size:mtimeMs` of the file. */
  identity: string;
}

/**
 * The `claude` executable a benchmark run uses, located once before any `setup` command runs
 * (Codex review of issue #117): an approved `setup` command runs with the user's permissions and
 * could put another `claude` — or another interpreter of a script launcher such as
 * `#!/usr/bin/env node` — earlier on `PATH`, or replace the file, and that program would then
 * receive the API key. Every agent run spawns the canonical path and first checks that it, and the
 * interpreter its `#!` line resolves to on the child's `PATH`, are still these files.
 */
export interface ClaudeExecutablePin extends PinnedFile {
  /** The `--version` line read when it was located. */
  versionLine: string;
  /** The interpreter of a `#!` launcher, or null for a binary. */
  interpreter: PinnedFile | null;
}

export type ClaudeExecutableLookup =
  { ok: true; pin: ClaudeExecutablePin } | Extract<ClaudeBinaryCheck, { ok: false }>;

function identityOf(info: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

/**
 * The interpreter command of a `#!` line: its first word, or for `env` (also `env -S …` and
 * `env NAME=value …`) the first word after the options and assignments, which `env` looks up on
 * `PATH`. Null for a file without a `#!` line or with an empty one.
 */
export function shebangCommand(head: string): string | null {
  if (!head.startsWith('#!')) return null;
  const words = (head.slice(2).split('\n')[0] as string).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  if (first === undefined || basename(first) !== 'env') return first ?? null;
  return rest.find((word) => !word.startsWith('-') && !word.includes('=')) ?? null;
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SHEBANG_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SHEBANG_MAX_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await handle.close();
  }
}

/** Where `command` leads now: an absolute path as is, a bare name on `env.PATH`. */
async function locate(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return isAbsolute(command) ? command : findExecutable(command, env);
}

async function pinFile(command: string, path: string): Promise<PinnedFile> {
  const canonical = await realpath(path);
  return { command, canonical, identity: identityOf(await stat(canonical)) };
}

/**
 * Checks the located binary (`checkClaudeBinary`) and pins its canonical path and identity, and
 * those of the interpreter its `#!` line names (looked up on `env.PATH`, the child's `PATH`).
 */
export async function pinClaudeExecutable(
  target: ClaudeCodeTarget,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeExecutableLookup> {
  const binary = checkClaudeBinary(target);
  if (!binary.ok) return binary;
  try {
    const canonical = await realpath(binary.executablePath);
    const launcher = await pinFile(canonical, canonical);
    const command = shebangCommand(await readHead(canonical));
    let interpreter: PinnedFile | null = null;
    if (command !== null) {
      const found = await locate(command, env);
      if (found === null) {
        return {
          ok: false,
          code: 'binary-not-found',
          detail: `The interpreter \`${command}\` of \`claude\` at ${binary.executablePath} was not found on PATH.`,
        };
      }
      interpreter = await pinFile(command, found);
    }
    return { ok: true, pin: { ...launcher, versionLine: binary.versionLine, interpreter } };
  } catch (error) {
    return {
      ok: false,
      code: 'binary-not-found',
      detail: `\`claude\` at ${binary.executablePath} cannot be resolved (${errorCode(error)}).`,
    };
  }
}

async function fileIssue(file: PinnedFile, env: NodeJS.ProcessEnv): Promise<string | null> {
  const found = await locate(file.command, env);
  if (found === null) return `${file.command} is no longer found on PATH`;
  if ((await realpath(found)) !== file.canonical) {
    return `${file.command} now resolves to another file than ${file.canonical}`;
  }
  if (identityOf(await stat(file.canonical)) !== file.identity) {
    return `${file.canonical} was replaced or changed after it was located`;
  }
  return null;
}

/**
 * Why the pinned executable or its interpreter is no longer the file located before `setup`, or
 * null when both still are: each must resolve to its pinned canonical path (the interpreter of an
 * `env` line on `env.PATH`, the child's `PATH`) and keep its device, inode, size and modification
 * time. Any error fails closed.
 */
export async function claudeExecutablePinIssue(
  pin: ClaudeExecutablePin,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    return (
      (await fileIssue(pin, env)) ??
      (pin.interpreter === null ? null : await fileIssue(pin.interpreter, env))
    );
  } catch (error) {
    return `claude at ${pin.canonical} cannot be checked (${errorCode(error)})`;
  }
}
