import { realpath, stat } from 'node:fs/promises';
import {
  checkClaudeBinary,
  type ClaudeBinaryCheck,
  type ClaudeCodeTarget,
} from '../claude-code-readiness';
import { errorCode } from '../workspace-pin';

/**
 * The `claude` executable a benchmark run uses, located once before any `setup` command runs
 * (Codex review of issue #117): an approved `setup` command runs with the user's permissions and
 * could put another `claude` earlier on `PATH` or replace the file, which would then receive the
 * API key. Every agent run spawns the canonical path and first checks it is still this file.
 */
export interface ClaudeExecutablePin {
  /** `realpath` of the located executable; spawned directly, without a `PATH` lookup. */
  canonical: string;
  /** The `--version` line read when it was located. */
  versionLine: string;
  /** `dev:ino:size:mtimeMs` of the file. */
  identity: string;
}

export type ClaudeExecutableLookup =
  { ok: true; pin: ClaudeExecutablePin } | Extract<ClaudeBinaryCheck, { ok: false }>;

function identityOf(info: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

/** Checks the located binary (`checkClaudeBinary`) and pins its canonical path and identity. */
export async function pinClaudeExecutable(
  target: ClaudeCodeTarget,
): Promise<ClaudeExecutableLookup> {
  const binary = checkClaudeBinary(target);
  if (!binary.ok) return binary;
  try {
    const canonical = await realpath(binary.executablePath);
    return {
      ok: true,
      pin: {
        canonical,
        versionLine: binary.versionLine,
        identity: identityOf(await stat(canonical)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'binary-not-found',
      detail: `\`claude\` at ${binary.executablePath} cannot be resolved (${errorCode(error)}).`,
    };
  }
}

/**
 * Why the pinned executable is no longer the file located before `setup`, or null when it still
 * is: its canonical path must resolve to itself (no ancestor re-linked) and the file must keep its
 * device, inode, size and modification time. Any error fails closed.
 */
export async function claudeExecutablePinIssue(pin: ClaudeExecutablePin): Promise<string | null> {
  try {
    if ((await realpath(pin.canonical)) !== pin.canonical) {
      return `claude at ${pin.canonical} now resolves to another file`;
    }
    if (identityOf(await stat(pin.canonical)) !== pin.identity) {
      return `claude at ${pin.canonical} was replaced or changed after it was located`;
    }
    return null;
  } catch (error) {
    return `claude at ${pin.canonical} cannot be checked (${errorCode(error)})`;
  }
}
