import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactBundle, ArtifactFormat } from '@directivebench/core';
import type { InstalledArtifact } from '../contract';
import { writeArtifactFiles } from '../install';
import type { ClaudeArtifactProfile } from './argv';
import { ClaudeCodeError } from './errors';
import { claudeSkillName } from './skill-name';
import { workspacePinIssue, type WorkspacePin } from './workspace-pin';

/** Artifact formats Claude Code can load from a workspace (SPEC-203 §4.1). */
export const CLAUDE_INSTALLABLE_FORMATS = [
  'skill-md',
  'claude-md',
  'agents-md',
  'claude-rule',
] as const satisfies readonly ArtifactFormat[];

export type ClaudeInstallableFormat = (typeof CLAUDE_INSTALLABLE_FORMATS)[number];

/** The import line that makes Claude Code load `AGENTS.md` through `CLAUDE.md` (SPEC-203 §4.1). */
export const AGENTS_MD_IMPORT = '@AGENTS.md';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isClaudeInstallableFormat(format: string): format is ClaudeInstallableFormat {
  return (CLAUDE_INSTALLABLE_FORMATS as readonly string[]).includes(format);
}

function assertInstallable(artifact: ArtifactBundle): ClaudeInstallableFormat {
  if (!isClaudeInstallableFormat(artifact.format)) {
    throw new ClaudeCodeError(
      'artifact-format-unsupported',
      `Artifact format ${artifact.format} is not compatible with adapter claude-code.`,
    );
  }
  return artifact.format;
}

/**
 * The per-type profile of an artifact for {@link buildClaudeArgv} (FR-118-08): a skill with its
 * resolved name, an instruction type without. Unsupported formats fail with
 * `artifact-format-unsupported` (FR-118-25).
 */
export function claudeArtifactProfile(artifact: ArtifactBundle): ClaudeArtifactProfile {
  const format = assertInstallable(artifact);
  return format === 'skill-md' ? { format, skillName: claudeSkillName(artifact) } : { format };
}

function conflict(path: string, reason: string): ClaudeCodeError {
  return new ClaudeCodeError('artifact-install-conflict', `Cannot install at ${path}: ${reason}.`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** `lstat` of a path, or null when nothing exists there; every other error propagates. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The current content of the instruction file `name` at the workspace root, or null when there is
 * none. An existing file must be a regular file with a single link that is still the same file
 * when opened (a link a `setup` command planted is refused, never read through).
 */
async function existingInstruction(workspaceDir: string, name: string): Promise<string | null> {
  const path = join(workspaceDir, name);
  const before = await lstatOrNull(path);
  if (before === null) return null;
  if (!before.isFile() || before.nlink !== 1) {
    throw conflict(name, 'it is not a regular file with a single link');
  }
  // O_NOFOLLOW is undefined on Windows and ORs to 0 there; the identity check below covers it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw conflict(name, 'it changed while it was being opened');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** `existing` followed by `text`, separated by a blank line when there is existing content. */
function appended(existing: string | null, text: string): string {
  return existing ? `${existing}\n\n${text}` : text;
}

/** Errors of `rename` that mean the destination is occupied or is not a plain path. */
const OCCUPIED = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR']);

/**
 * Moves every top-level entry of the staging directory into the workspace with `rename`, then
 * checks what landed. `rename` replaces a link at the destination itself instead of following it
 * and fails on a non-empty directory, so a `.claude` that a still-running `setup` process planted
 * (a link, a file or a populated directory) makes the install fail closed and nothing is written
 * outside the workspace.
 */
async function moveIntoPlace(stage: string, workspaceDir: string): Promise<void> {
  for (const name of (await readdir(stage)).sort()) {
    try {
      await rename(join(stage, name), join(workspaceDir, name));
    } catch (error) {
      const code = errorCode(error) as string;
      if (OCCUPIED.has(code)) throw conflict(name, `the destination is occupied (${code})`);
      throw error;
    }
    // A direct child of the workspace that is a real directory or file (not a link) lies inside it.
    const landed = await lstat(join(workspaceDir, name));
    const plain = name === '.claude' ? landed.isDirectory() : landed.isFile() && landed.nlink === 1;
    if (!plain || landed.isSymbolicLink())
      throw conflict(name, 'it was replaced after installation');
  }
}

/**
 * Installs one artifact version into a workspace with the Claude Code convention (SPEC-203 §4.1),
 * for the candidate and for an A/B baseline alike (FR-118-11):
 *
 * - `skill-md` → `.claude/skills/<slug>/` with every bundled file;
 * - `claude-rule` → `.claude/rules/<file>`;
 * - `claude-md` → appended to `./CLAUDE.md`;
 * - `agents-md` → appended to `./AGENTS.md`, plus an `@AGENTS.md` import appended to `./CLAUDE.md`,
 *   so every Claude Code version loads it (versions before 2.1.277 do not read `AGENTS.md`, and
 *   later ones skip it when a `CLAUDE.md` exists).
 *
 * Nothing is written into the workspace by pathname: the complete result is built in a private
 * staging directory (`mkdtemp`, mode 0700) next to the workspace — so on the same file system,
 * which the workspace's parent must allow — and moved in by `rename` per top-level entry
 * (`.claude`, `CLAUDE.md`, `AGENTS.md`). A workspace that already has a `.claude` (which
 * FR-118-06 forbids anyway) fails closed. Other formats fail with `artifact-format-unsupported`;
 * an occupied, linked or hard-linked target with `artifact-install-conflict`.
 *
 * The workspace is passed as its {@link WorkspacePin}: the path must still be the pinned directory
 * before existing files are read, before the move and after it (`workspace-replaced` otherwise),
 * and the staging directory is created beside its canonical path.
 *
 * Precondition: no process a `setup` command started is still running (SPEC-118 FR-118-27). The
 * staging closes the window between checks and writes, but such a process could still change the
 * workspace after installation; the pre-spawn inspection then catches what it can.
 */
export async function installClaudeArtifact(
  workspace: WorkspacePin,
  artifact: ArtifactBundle,
): Promise<InstalledArtifact> {
  const format = assertInstallable(artifact);
  const workspaceDir = workspace.canonical;
  const assertPinned = async () => {
    const issue = await workspacePinIssue(workspace);
    if (issue !== null) throw new ClaudeCodeError('workspace-replaced', `${issue}.`);
  };
  if (format === 'skill-md' && !SLUG.test(artifact.slug)) {
    throw conflict(`.claude/skills/${artifact.slug}`, 'the slug is not a single plain segment');
  }
  // A rule is one file in `.claude/rules/`.
  const nested = artifact.files.find((file) => file.path.includes('/'));
  if (format === 'claude-rule' && nested) {
    throw conflict(`.claude/rules/${nested.path}`, 'a rule file must not be nested');
  }
  const text = artifact.files.map((file) => file.content).join('\n\n');
  await assertPinned();
  const claudeMd =
    format === 'claude-md' || format === 'agents-md'
      ? await existingInstruction(workspaceDir, 'CLAUDE.md')
      : null;
  const agentsMd =
    format === 'agents-md' ? await existingInstruction(workspaceDir, 'AGENTS.md') : null;
  const stage = await mkdtemp(join(dirname(workspaceDir), '.claude-install-'));
  try {
    let paths: string[];
    if (format === 'skill-md') {
      paths = await writeArtifactFiles(stage, `.claude/skills/${artifact.slug}`, artifact);
    } else if (format === 'claude-rule') {
      paths = await writeArtifactFiles(stage, '.claude/rules', artifact);
    } else if (format === 'claude-md') {
      await writeFile(join(stage, 'CLAUDE.md'), appended(claudeMd, text), { flag: 'wx' });
      paths = ['CLAUDE.md'];
    } else {
      await writeFile(join(stage, 'AGENTS.md'), appended(agentsMd, text), { flag: 'wx' });
      await writeFile(join(stage, 'CLAUDE.md'), appended(claudeMd, `${AGENTS_MD_IMPORT}\n`), {
        flag: 'wx',
      });
      paths = ['AGENTS.md', 'CLAUDE.md'];
    }
    await assertPinned();
    await moveIntoPlace(stage, workspaceDir);
    await assertPinned();
    return { paths };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
