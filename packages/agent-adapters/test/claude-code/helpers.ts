import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Stream fixtures: NDJSON in the documented `stream-json` format (SPEC-203 §4/§6, C1/C7) with the
 * field names of the message schemas in the local `claude` 2.1.302 binary (evidence L3). They were
 * constructed, not recorded from a session; the opt-in live check (SPEC-118 AC-22) replaces them
 * with redacted recordings.
 */
export const STREAM_FIXTURES = join(import.meta.dirname, '../fixtures/claude-code/2.1.302');

/** The text of one stream fixture. */
export function fixture(name: string): string {
  return readFileSync(join(STREAM_FIXTURES, `${name}.ndjson`), 'utf8');
}
