import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The identity of a run workspace, recorded when the workspace is created and before any untrusted
 * command (`setup`) runs in it (SPEC-118 §12). A `setup` command can move the workspace away and
 * put a link to a host directory at its path; every later step compares the path with this pin
 * before it reads, writes or inspects, so it never operates on the replacement.
 */
export interface WorkspacePin {
  /** The workspace path as the run uses it (absolute). */
  path: string;
  /** Its canonical path (`realpath`) at creation. */
  canonical: string;
  dev: number;
  ino: number;
}

/**
 * Pins a freshly created workspace: it must be a real directory (not a link). The orchestrator
 * calls this right after creating the workspace and before `setup` runs.
 */
export async function pinWorkspace(workspaceDir: string): Promise<WorkspacePin> {
  const path = resolve(workspaceDir);
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('The workspace must be a real directory, not a link.');
  return { path, canonical: await realpath(path), dev: info.dev, ino: info.ino };
}

/** The `code` of a file system error, for messages. */
export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error';
}

/**
 * Why the workspace path no longer is the pinned directory, or null when it still is: its last
 * component must be a real directory with the pinned device and inode, and its canonical path
 * must be unchanged (so no ancestor was re-linked either). Any error fails closed.
 */
export async function workspacePinIssue(pin: WorkspacePin): Promise<string | null> {
  try {
    const info = await lstat(pin.path);
    if (!info.isDirectory()) return 'the workspace path is no longer a directory';
    if (info.dev !== pin.dev || info.ino !== pin.ino) {
      return 'the workspace path now holds another directory';
    }
    if ((await realpath(pin.path)) !== pin.canonical) {
      return 'the workspace path now resolves to another place';
    }
    return null;
  } catch (error) {
    return `the workspace cannot be inspected (${errorCode(error)})`;
  }
}
