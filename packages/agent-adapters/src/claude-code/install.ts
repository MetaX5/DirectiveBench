import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactBundle, ArtifactFormat } from '@directivebench/core';
import type { InstalledArtifact } from '../contract';
import { writeArtifactFiles } from '../install';
import type { ClaudeArtifactProfile } from './argv';
import { ClaudeCodeError } from './errors';
import { claudeSkillName } from './skill-name';

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
 * Throws `artifact-install-conflict` unless every existing component of `relativeDir` below the
 * workspace is a real directory. `setup` commands run before installation, so a symbolic link
 * planted at `.claude` would otherwise redirect the install onto a host directory.
 */
async function assertPlainDirectories(workspaceDir: string, relativeDir: string): Promise<void> {
  let current = '';
  for (const segment of relativeDir.split('/')) {
    current = current ? `${current}/${segment}` : segment;
    const info = await lstatOrNull(join(workspaceDir, current));
    if (info === null) return;
    if (!info.isDirectory()) throw conflict(current, 'it exists and is not a directory');
  }
}

async function writeInto(
  workspaceDir: string,
  targetDir: string,
  artifact: ArtifactBundle,
): Promise<string[]> {
  await assertPlainDirectories(workspaceDir, targetDir);
  try {
    return await writeArtifactFiles(workspaceDir, targetDir, artifact);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw conflict(targetDir, 'a file already exists there');
    throw error;
  }
}

/**
 * Appends `text` to the instruction file `name` at the workspace root, separated by a blank line
 * from existing content, or creates it (exclusive create). An existing file must be a regular
 * file with a single link that is still the same file when opened, so a link a `setup` command
 * planted can never redirect the write to a host file.
 */
async function appendInstruction(workspaceDir: string, name: string, text: string): Promise<void> {
  const path = join(workspaceDir, name);
  const before = await lstatOrNull(path);
  if (before === null) {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    return;
  }
  if (!before.isFile() || before.nlink !== 1) {
    throw conflict(name, 'it is not a regular file with a single link');
  }
  // O_NOFOLLOW is undefined on Windows and ORs to 0 there; the identity check below covers it.
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw conflict(name, 'it changed while it was being opened');
    }
    await handle.writeFile(opened.size > 0 ? `\n\n${text}` : text);
  } finally {
    await handle.close();
  }
}

/**
 * Installs one artifact version into a workspace with the Claude Code convention (SPEC-203 §4.1),
 * for the candidate and for an A/B baseline alike (FR-118-11):
 *
 * - `skill-md` → `.claude/skills/<slug>/` with every bundled file (the target must not exist);
 * - `claude-rule` → `.claude/rules/<file>` (an existing file is a conflict);
 * - `claude-md` → appended to `./CLAUDE.md`;
 * - `agents-md` → appended to `./AGENTS.md`, plus an `@AGENTS.md` import appended to `./CLAUDE.md`,
 *   so every Claude Code version loads it (versions before 2.1.277 do not read `AGENTS.md`, and
 *   later ones skip it when a `CLAUDE.md` exists).
 *
 * Other formats fail with `artifact-format-unsupported`; a target that exists, is not a plain
 * directory or file, or is reached through a symbolic link fails with `artifact-install-conflict`.
 */
export async function installClaudeArtifact(
  workspaceDir: string,
  artifact: ArtifactBundle,
): Promise<InstalledArtifact> {
  const format = assertInstallable(artifact);
  if (format === 'skill-md') {
    if (!SLUG.test(artifact.slug)) {
      throw conflict(`.claude/skills/${artifact.slug}`, 'the slug is not a single plain segment');
    }
    const targetDir = `.claude/skills/${artifact.slug}`;
    await assertPlainDirectories(workspaceDir, '.claude/skills');
    if ((await lstatOrNull(join(workspaceDir, targetDir))) !== null)
      throw conflict(targetDir, 'it already exists');
    return { paths: await writeInto(workspaceDir, targetDir, artifact) };
  }
  if (format === 'claude-rule')
    return { paths: await writeInto(workspaceDir, '.claude/rules', artifact) };
  const text = artifact.files.map((file) => file.content).join('\n\n');
  if (format === 'claude-md') {
    await appendInstruction(workspaceDir, 'CLAUDE.md', text);
    return { paths: ['CLAUDE.md'] };
  }
  await appendInstruction(workspaceDir, 'AGENTS.md', text);
  await appendInstruction(workspaceDir, 'CLAUDE.md', `${AGENTS_MD_IMPORT}\n`);
  return { paths: ['AGENTS.md', 'CLAUDE.md'] };
}
