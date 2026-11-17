import { posix } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { ArtifactBundle } from '@directivebench/core';
import type { Database } from '../client';
import { artifactOccurrences, artifactVersions } from '../schema';
import { getArtifactBundle } from './artifacts';

/**
 * Code-unit order (SPEC-126 FR-126-24), independent of the locale. Branch-free, so its coverage
 * does not depend on which of two random ids sorts first.
 */
function compareCodeUnits(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** The last segment of a repository-relative path, or null for the repository root. */
function folderOf(path: string | null): string | null {
  return path ? posix.basename(path) : null;
}

/**
 * The folder a skill version without a frontmatter `name` is installed in and named after
 * (SPEC-203 §4.1, issue 245). The repository's own agent sees the folder of the current
 * occurrence, so this is the basename of the path of the artifact's representative active
 * occurrence, chosen like `refreshSourceFields` chooses the one that names the artifact (SPEC-103
 * FR-103-16, SPEC-126 FR-126-07): the highest version number, then the oldest occurrence
 * `created_at`, then id. A folder rename creates no version (FR-103-09), so the version's own
 * `source_path` is only the fallback (no active occurrence, or one at the repository root); null
 * when neither names a folder, and the adapter then uses the slug.
 */
async function skillFolderName(
  db: Database,
  artifactId: string,
  versionId: string,
): Promise<string | null> {
  const occurrences = await db
    .select({
      id: artifactOccurrences.id,
      path: artifactOccurrences.path,
      createdAt: artifactOccurrences.createdAt,
      version: artifactVersions.version,
    })
    .from(artifactOccurrences)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactOccurrences.latestVersionId))
    .where(
      and(eq(artifactOccurrences.artifactId, artifactId), eq(artifactOccurrences.status, 'active')),
    );
  const [chosen] = occurrences.sort(
    (a, b) =>
      b.version - a.version ||
      compareCodeUnits(a.createdAt, b.createdAt) ||
      compareCodeUnits(a.id, b.id),
  );
  const sourceFolders = (
    await db
      .select({ sourcePath: artifactVersions.sourcePath })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, versionId))
  ).map((row) => folderOf(row.sourcePath));
  const folders = [...(chosen ? [folderOf(chosen.path)] : []), ...sourceFolders];
  return folders.find((folder) => folder !== null) ?? null;
}

/**
 * Loads one exact artifact version as agent adapters install it: `getArtifactBundle` plus, for a
 * `skill-md` version, the `folderName` of SPEC-203 §4.1 (null for every other format). The CLI
 * plan and the runner both load bundles through this function, so both resolve the same name for
 * the same repository state.
 */
export async function getInstallableArtifactBundle(
  db: Database,
  versionId: string,
): Promise<ArtifactBundle | null> {
  const bundle = await getArtifactBundle(db, versionId);
  if (!bundle) return null;
  if (bundle.format !== 'skill-md') return { ...bundle, folderName: null };
  return { ...bundle, folderName: await skillFolderName(db, bundle.artifactId, versionId) };
}
