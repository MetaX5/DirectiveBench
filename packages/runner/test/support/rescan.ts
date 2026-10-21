import {
  assignBenchmarkSuite,
  assignCategoriesBySlug,
  getArtifactDetail,
  importSuiteVersion,
  seedPredefinedCategories,
  type DatabaseHandle,
} from '@directivebench/database';
import { expect } from 'vitest';

/**
 * Helpers for the rescan tests of issue #19 (SPEC-103 FR-103-06/07, SPEC-001 principle 15),
 * shared by the local and the hosted scan tests.
 */

export interface StoredVersion {
  /** The row id: a version deleted and re-inserted with the same number would differ. */
  id: string;
  version: number;
  contentHash: string;
}

export interface ArtifactHistory {
  artifactId: string;
  /** The occurrence's current version. */
  latest: number;
  /** Every version of the artifact, oldest first. */
  versions: StoredVersion[];
}

/** Per occurrence path: the artifact, its current version and its whole version history. */
export function versionHistory(handle: DatabaseHandle): Record<string, ArtifactHistory> {
  const occurrences = handle.sqlite
    .prepare(
      `select o.path, o.artifact_id as artifactId, v.version as latest
         from artifact_occurrences o
         join artifact_versions v on v.id = o.latest_version_id
        order by o.path`,
    )
    .all() as unknown as { path: string; artifactId: string; latest: number }[];
  const versions = handle.sqlite.prepare(
    `select id, version, content_hash as contentHash from artifact_versions
      where artifact_id = ? order by version`,
  );
  return Object.fromEntries(
    occurrences.map(({ path, artifactId, latest }) => [
      path,
      {
        artifactId,
        latest,
        versions: (versions.all(artifactId) as unknown as StoredVersion[]).map((row) => ({
          // node:sqlite rows have a null prototype; copy them for `toEqual`.
          ...row,
        })),
      },
    ]),
  );
}

/**
 * The history expected after a rescan that changed only `path`: that artifact gains exactly one
 * version, the next number with a hash none of its versions had, and keeps every earlier one;
 * every other artifact is unchanged.
 */
export function withOneNewVersion(
  before: Record<string, ArtifactHistory>,
  path: string,
): Record<string, ArtifactHistory> {
  const changed = before[path];
  if (!changed) throw new Error(`No occurrence at ${path}`);
  const next = Math.max(...changed.versions.map((v) => v.version)) + 1;
  const known = changed.versions.map((v) => v.contentHash).join('|');
  return {
    ...before,
    [path]: {
      artifactId: changed.artifactId,
      latest: next,
      versions: [
        ...changed.versions,
        {
          id: expect.any(String) as string,
          version: next,
          contentHash: expect.not.stringMatching(new RegExp(`^(${known})$`)),
        },
      ],
    },
  };
}

/**
 * What a user assigns to an artifact (SPEC-001 principle 15): a category, tags, notes and a
 * benchmark suite. Nothing in a scan may change any of it.
 */
export async function assignUserMetadata(
  handle: DatabaseHandle,
  artifactId: string,
): Promise<void> {
  await seedPredefinedCategories(handle.db);
  expect(await assignCategoriesBySlug(handle.db, artifactId, ['security'])).toEqual({
    assigned: ['security'],
    unknown: [],
  });
  // No repository function edits tags or notes yet (SPEC-101 metadata editing is planned).
  handle.sqlite
    .prepare('update artifacts set tags = ?, notes = ? where id = ?')
    .run(JSON.stringify(['mine', 'reviewed']), 'Keep this note.', artifactId);
  const suite = await importSuiteVersion(handle, {
    slug: 'rescan-suite',
    name: 'Rescan suite',
    description: null,
    schemaVersion: 1,
    definition: {},
    fixtures: {},
    contentHash: 'rescan-suite-hash',
    sourcePath: null,
    approval: null,
  });
  await assignBenchmarkSuite(handle.db, artifactId, suite.suiteId);
}

/** The user-managed metadata of an artifact, as the detail page reads it. */
export async function userMetadata(handle: DatabaseHandle, artifactId: string) {
  const detail = await getArtifactDetail(handle.db, artifactId);
  return {
    categories: detail?.categories.map((c) => c.slug),
    tags: detail?.artifact.tags,
    notes: detail?.artifact.notes,
    suites: detail?.suites.map((s) => s.name),
  };
}

export const ASSIGNED_METADATA = {
  categories: ['security'],
  tags: ['mine', 'reviewed'],
  notes: 'Keep this note.',
  suites: ['Rescan suite'],
};
