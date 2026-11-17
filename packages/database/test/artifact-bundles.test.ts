import { eq } from 'drizzle-orm';
import { parseArtifactFile } from '@directivebench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  applyRepositoryScan,
  enqueueRepositoryScanJob,
  finishJob,
  getArtifactBundle,
  getInstallableArtifactBundle,
  schema,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { registerLocal } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// Issue 245 (SPEC-203 §4.1): the folder a skill without a frontmatter `name` is installed in is
// the folder of the artifact's representative active occurrence, chosen like `artifacts.name`
// (SPEC-103 FR-103-16), else the version's `source_path` folder, else none (the slug).

const getHandle = useTestDatabase();
const signal = new AbortController().signal;

let clock = Date.parse('2026-05-01T00:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.parse('2026-05-01T00:00:00.000Z');
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});

function skillMd(body = 'Review the diff.', name: string | null = null) {
  return `---\n${name === null ? '' : `name: ${name}\n`}description: Reviews code\n---\n${body}\n`;
}

/** A discovered skill as the runner stores it, parsed like discovery. */
function skill(dir: string, content: string): ScannedArtifactInput {
  const parsed = parseArtifactFile(dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`, content);
  return {
    path: dir,
    name: parsed.name,
    type: parsed.type,
    description: parsed.description,
    format: parsed.format,
    primaryFile: 'SKILL.md',
    files: [{ path: 'SKILL.md', content }],
    parsedMetadata: { frontmatter: parsed.frontmatter, skipped: [] },
  };
}

async function local(handle: DatabaseHandle, name: string) {
  return (
    await registerLocal(handle, { location: `/srv/${name}`, name, provider: 'local-directory' })
  ).repository.id;
}

async function scan(
  handle: DatabaseHandle,
  repositoryId: string,
  artifacts: ScannedArtifactInput[],
) {
  clock += 1_000;
  vi.setSystemTime(clock);
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  await acquireNextJob(handle.db, 'runner');
  try {
    await applyRepositoryScan(handle, {
      repositoryId,
      jobId: job.id,
      artifacts,
      unobserved: [],
      signal,
      commitSha: null,
      branch: null,
    });
  } finally {
    await finishJob(handle.db, job.id, 'completed');
  }
}

async function bySlug(handle: DatabaseHandle, slug: string) {
  const artifact = await handle.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.slug, slug))
    .get();
  if (!artifact) throw new Error(`no artifact ${slug}`);
  const versions = await handle.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
    .orderBy(schema.artifactVersions.version);
  return { artifact, versions };
}

describe('getInstallableArtifactBundle (issue 245, SPEC-203 §4.1)', () => {
  it('names a renamed nameless skill after its new folder, although its version keeps the old source path', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd())]);
    await scan(handle, a, [skill('skills/code-review', skillMd())]);
    const { artifact, versions } = await bySlug(handle, 'review');
    // A directory move creates no version (FR-103-09): the version still names the old folder.
    expect(versions.map((version) => version.sourcePath)).toEqual(['skills/review']);
    const bundle = await getInstallableArtifactBundle(handle.db, versions[0]!.id);
    expect(bundle).toEqual({
      ...(await getArtifactBundle(handle.db, versions[0]!.id)),
      folderName: 'code-review',
    });
    expect(bundle).toMatchObject({ slug: 'review', name: 'code-review' });
    expect(artifact.name).toBe('code-review');
  });

  it('names a nameless skill whose slug got a suffix after its folder', async () => {
    const handle = getHandle();
    await scan(handle, await local(handle, 'a'), [skill('skills/review', skillMd('A'))]);
    await scan(handle, await local(handle, 'b'), [skill('skills/review', skillMd('B'))]);
    const { versions } = await bySlug(handle, 'review-2');
    expect(await getInstallableArtifactBundle(handle.db, versions[0]!.id)).toMatchObject({
      slug: 'review-2',
      folderName: 'review',
    });
  });

  it('takes the folder of the representative occurrence: highest version, then oldest', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    // Exact copies link only under one name (rule 3), so these declare one; the folder is
    // resolved the same way whatever the frontmatter says (the adapter decides whether to use it).
    const copy = skillMd('Review the diff.', 'review');
    await scan(handle, a, [skill('skills/review', copy)]);
    // Two more copies in another repository: one artifact, three occurrences of version 1; the
    // oldest occurrence, in repository a, is the representative one.
    await scan(handle, b, [skill('tools/code-review', copy), skill('x/lint', copy)]);
    const {
      versions: [v1],
    } = await bySlug(handle, 'review');
    expect((await getInstallableArtifactBundle(handle.db, v1!.id))?.folderName).toBe('review');
    // An edit in repository b makes version 2 there (rule 1): that occurrence now represents the
    // artifact, also for a run of version 1.
    await scan(handle, b, [
      skill('tools/code-review', skillMd('Edited.', 'review')),
      skill('x/lint', copy),
    ]);
    const { versions } = await bySlug(handle, 'review');
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      expect((await getInstallableArtifactBundle(handle.db, version.id))?.folderName).toBe(
        'code-review',
      );
    }
  });

  it('breaks a tie between occurrences of one scan by occurrence id', async () => {
    const handle = getHandle();
    const copy = skillMd('Review the diff.', 'review');
    await scan(handle, await local(handle, 'a'), [
      skill('tools/code-review', copy),
      skill('x/lint', copy),
    ]);
    const occurrences = await handle.db.select().from(schema.artifactOccurrences);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.createdAt).toBe(occurrences[1]!.createdAt);
    const [first] = occurrences.sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(
      (await getInstallableArtifactBundle(handle.db, first!.latestVersionId))?.folderName,
    ).toBe(first!.path.split('/').pop());
  });

  it("falls back to the version's source path without an active occurrence, then to none at the root", async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd())]);
    await scan(handle, a, [skill('skills/code-review', skillMd())]);
    // A complete scan without it marks the occurrence removed (an empty scan would keep it).
    await scan(handle, a, [skill('skills/other', skillMd('Other.'))]);
    const { versions } = await bySlug(handle, 'review');
    expect((await getInstallableArtifactBundle(handle.db, versions[0]!.id))?.folderName).toBe(
      'review',
    );

    const root = await local(handle, 'root');
    await scan(handle, root, [skill('', skillMd('Root.'))]);
    const { versions: rootVersions } = await bySlug(handle, 'skill');
    expect(
      (await getInstallableArtifactBundle(handle.db, rootVersions[0]!.id))?.folderName,
    ).toBeNull();
    // At the root with no active occurrence either.
    await scan(handle, root, [skill('skills/another', skillMd('Another.'))]);
    expect(
      (await getInstallableArtifactBundle(handle.db, rootVersions[0]!.id))?.folderName,
    ).toBeNull();
  });

  it('sets no folder for other formats and returns null for an unknown version', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const content = '# Rules\n';
    const parsed = parseArtifactFile('docs/AGENTS.md', content);
    await scan(handle, a, [
      {
        path: 'docs/AGENTS.md',
        name: parsed.name,
        type: parsed.type,
        description: parsed.description,
        format: parsed.format,
        primaryFile: 'AGENTS.md',
        files: [{ path: 'AGENTS.md', content }],
        parsedMetadata: { frontmatter: parsed.frontmatter },
      },
    ]);
    const version = await handle.db.select().from(schema.artifactVersions).get();
    expect(await getInstallableArtifactBundle(handle.db, version!.id)).toMatchObject({
      format: 'agents-md',
      folderName: null,
    });
    expect(await getInstallableArtifactBundle(handle.db, 'artv_missing')).toBeNull();
  });
});
