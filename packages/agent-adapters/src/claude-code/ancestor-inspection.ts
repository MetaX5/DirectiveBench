import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { errorCode, type WorkspacePin } from '../workspace-pin';
import type { WorkspaceFinding } from './workspace-inspection';

/**
 * Names Claude Code loads from the working directory **and its ancestors** (C3: project skills up
 * to the repository root; C4: `CLAUDE.md`, `CLAUDE.local.md` and, for newer versions, `AGENTS.md`
 * from every ancestor; C12: the other configuration surfaces of FR-118-06), compared exactly.
 */
export const ANCESTOR_CLAUDE_NAMES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude',
  '.claude-plugin',
  '.mcp.json',
  '.worktreeinclude',
  '.claude.json',
] as const;

const DETAIL =
  'Claude Code loads instructions or configuration from this ancestor of the workspace';

/** `homeDir` as given and as resolved through links. */
async function homeForms(homeDir: string): Promise<string[]> {
  const given = resolve(homeDir);
  try {
    return [given, await realpath(given)];
  } catch {
    // Fails closed: without the resolved form fewer paths are exempt, never more (a home that
    // does not exist cannot be an ancestor under another name anyway).
    return [given];
  }
}

/**
 * The workspace's ancestors, from its parent up to the file system root, checked for the names
 * Claude Code would load from them (FR-118-06; Codex review of issue #117): the inspection of the
 * workspace itself cannot see them, and an approved `setup` command can write `../CLAUDE.md` into
 * the run directory without touching the pinned workspace. Each existing entry is a
 * `workspace-contains-claude-config` finding with a workspace-relative path (`../CLAUDE.md`); an
 * entry whose existence cannot be determined fails closed. Exempt: the agent `HOME`'s own
 * `.claude` and `.claude.json`, the user-level configuration Local Subscription Mode runs with by
 * design (`ambient-user-config`); in API Key Mode `HOME` is run-local and no ancestor. The walk
 * follows the canonical path, the working directory `claude` is started in.
 */
export async function inspectWorkspaceAncestors(
  workspace: WorkspacePin,
  homeDir: string,
): Promise<WorkspaceFinding[]> {
  const exempt = new Set(
    (await homeForms(homeDir)).flatMap((home) => [
      join(home, '.claude'),
      join(home, '.claude.json'),
    ]),
  );
  const findings: WorkspaceFinding[] = [];
  const add = (absolute: string, detail: string) => {
    findings.push({
      code: 'workspace-contains-claude-config',
      path: relative(workspace.canonical, absolute).split(sep).join('/'),
      detail,
    });
  };
  for (let dir = dirname(workspace.canonical); ; dir = dirname(dir)) {
    for (const name of ANCESTOR_CLAUDE_NAMES) {
      const absolute = join(dir, name);
      if (exempt.has(absolute)) continue;
      try {
        await lstat(absolute);
        add(absolute, DETAIL);
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT') add(absolute, `cannot be checked (${code})`);
      }
    }
    if (dirname(dir) === dir) return findings;
  }
}
