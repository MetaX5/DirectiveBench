import {
  hashManifest,
  sha256,
  type ArtifactBundle,
  type ArtifactFormat,
} from '@directivebench/core';

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
