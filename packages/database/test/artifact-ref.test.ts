import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_REF_SUGGESTIONS,
  ArtifactRefError,
  importArtifactVersion,
  resolveArtifactRef,
  schema,
} from '../src/index';
import { artifactInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

async function rejection(promise: Promise<unknown>): Promise<ArtifactRefError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ArtifactRefError);
  return error as ArtifactRefError;
}

describe('resolveArtifactRef (SPEC-118 FR-118-22)', () => {
  it('resolves an id or a slug to the latest version, or to the requested one', async () => {
    const handle = getHandle();
    const v1 = await importArtifactVersion(handle, artifactInput('one'));
    const v2 = await importArtifactVersion(handle, artifactInput('two'));
    const bySlug = await resolveArtifactRef(handle.db, 'validate');
    expect(bySlug).toMatchObject({
      artifact: { id: v1.artifactId, slug: 'validate', name: 'validate', type: 'skill' },
      version: { id: v2.versionId, version: 2, format: 'skill-md' },
      versionCount: 2,
    });
    const byId = await resolveArtifactRef(handle.db, v1.artifactId, 1);
    expect(byId.version).toMatchObject({ id: v1.versionId, version: 1 });
    expect(byId.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefers the id when one artifact id is another artifact slug', async () => {
    const handle = getHandle();
    const first = await importArtifactVersion(handle, artifactInput('a'));
    await importArtifactVersion(
      handle,
      artifactInput('b', { slug: first.artifactId, path: 'skills/other' }),
    );
    const resolved = await resolveArtifactRef(handle.db, first.artifactId);
    expect(resolved.artifact.slug).toBe('validate');
  });

  it('names the closest slugs for an unknown reference, escaping LIKE wildcards', async () => {
    const handle = getHandle();
    for (const slug of ['estimate-project', 'estimate-pm', 'deploy']) {
      await importArtifactVersion(handle, artifactInput(slug, { slug, path: `skills/${slug}` }));
    }
    const unknown = await rejection(resolveArtifactRef(handle.db, 'ESTIMATE'));
    expect(unknown.code).toBe('artifact-not-found');
    expect(unknown.message).toBe('No artifact has the id or slug "ESTIMATE".');
    expect(unknown.candidates).toEqual(['estimate-pm', 'estimate-project']);
    // `%` and `_` are literal characters, not wildcards.
    expect((await rejection(resolveArtifactRef(handle.db, '%'))).candidates).toEqual([]);
    expect((await rejection(resolveArtifactRef(handle.db, 'e_t'))).candidates).toEqual([]);
  });

  it(`names at most ${ARTIFACT_REF_SUGGESTIONS} candidates`, async () => {
    const handle = getHandle();
    for (let index = 0; index < ARTIFACT_REF_SUGGESTIONS + 2; index += 1) {
      const slug = `skill-${index}`;
      await importArtifactVersion(handle, artifactInput(slug, { slug, path: `skills/${slug}` }));
    }
    const error = await rejection(resolveArtifactRef(handle.db, 'skill'));
    expect(error.candidates).toHaveLength(ARTIFACT_REF_SUGGESTIONS);
  });

  it('lists the newest versions when the requested version does not exist', async () => {
    const handle = getHandle();
    await importArtifactVersion(handle, artifactInput('one'));
    await importArtifactVersion(handle, artifactInput('two'));
    const error = await rejection(resolveArtifactRef(handle.db, 'validate', 7));
    expect(error).toMatchObject({
      code: 'version-not-found',
      message: 'Artifact "validate" has no version 7.',
      candidates: ['v2', 'v1'],
    });
  });

  it('refuses an artifact without versions', async () => {
    const handle = getHandle();
    const now = new Date().toISOString();
    await handle.db.insert(schema.artifacts).values({
      id: 'art_empty',
      slug: 'empty',
      name: 'Empty',
      type: 'rule',
      createdAt: now,
      updatedAt: now,
    });
    expect(await rejection(resolveArtifactRef(handle.db, 'empty'))).toMatchObject({
      code: 'version-not-found',
      message: 'Artifact "empty" has no versions.',
      candidates: [],
    });
  });
});
