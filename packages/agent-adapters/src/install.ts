import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import type { ArtifactBundle } from '@directivebench/core';
import { resolveInside } from './paths';

/**
 * Writes artifact files below `targetDir` (workspace-relative). Paths are validated so a
 * malicious artifact cannot write outside the workspace.
 */
export async function writeArtifactFiles(
  workspaceDir: string,
  targetDir: string,
  artifact: ArtifactBundle,
): Promise<string[]> {
  const written: string[] = [];
  const targetRoot = resolveInside(workspaceDir, targetDir);
  for (const file of artifact.files) {
    // Validate against the install directory itself, not just the workspace.
    const absolute = resolveInside(targetRoot, file.path);
    const relative = posix.join(targetDir, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, { flag: 'wx' });
    written.push(relative);
  }
  return written;
}
