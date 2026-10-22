import {
  hashManifest,
  sha256,
  type ArtifactBundle,
  type ArtifactFormat,
} from '@directivebench/core';
import {
  inspectWorkspace,
  installClaudeArtifact,
  type WorkspaceFinding,
  type WorkspaceInspectionOptions,
} from '../../src/claude-code';
import { pinWorkspace } from '../../src/workspace-pin';
import type { InstalledArtifact } from '../../src/contract';

/** An artifact bundle with the given files (path → content). */
export function bundle(
  format: ArtifactFormat,
  files: Record<string, string>,
  overrides: Partial<ArtifactBundle> = {},
): ArtifactBundle {
  const list = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  }));
  return {
    artifactId: 'art_1',
    versionId: 'ver_1',
    slug: 'pdf',
    name: 'pdf',
    type: format === 'skill-md' ? 'skill' : format === 'claude-rule' ? 'rule' : 'instruction',
    format,
    contentHash: hashManifest(list),
    files: list,
    ...overrides,
  };
}

/** Installs into a workspace pinned right before the call. */
export async function installPinned(
  workspaceDir: string,
  artifact: ArtifactBundle,
): Promise<InstalledArtifact> {
  return installClaudeArtifact(await pinWorkspace(workspaceDir), artifact);
}

/** Inspects a workspace pinned right before the call. */
export async function inspectPinned(
  workspaceDir: string,
  options: WorkspaceInspectionOptions,
): Promise<WorkspaceFinding[]> {
  return inspectWorkspace(await pinWorkspace(workspaceDir), options);
}
