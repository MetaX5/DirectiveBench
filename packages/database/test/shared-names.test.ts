import { describe, expect, it } from 'vitest';
import {
  assignArtifactCategory,
  assignBenchmarkSuite,
  createCategory,
  enqueueBenchmarkJob,
  getArtifactDetail,
  getSuiteDetail,
  importArtifactVersion,
  importSuiteVersion,
  listArtifactRuns,
  listArtifacts,
  listBenchmarkRuns,
  listJobs,
  listSuites,
  setCategoryArchived,
  updateCategory,
  type DatabaseHandle,
} from '../src/index';
import { artifactInput, seedRun, seedTargets, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// Issue 227: list rows say whether another row anywhere in the database shares their name, so
// the web app shows an ID or a slug only on a clash, the same way on every page.

const getHandle = useTestDatabase();

async function category(handle: DatabaseHandle, name: string) {
  const outcome = await createCategory(handle, { name, description: null });
  if (outcome.status !== 'created') throw new Error(`${name}: ${outcome.status}`);
  return outcome.category;
}

describe('suite name shared', () => {
  it('flags a suite whose name another suite has, in every list that names suites', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle, {
      suite: { slug: 'safety-a', name: 'Safety' },
    });
    const unique = await importSuiteVersion(
      handle,
      suiteInput('u', { slug: 'unique', name: 'Unique' }),
    );
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);
    await assignBenchmarkSuite(handle.db, targets.artifactId, unique.suiteId);
    await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: targets.suiteVersionId,
      artifactVersionId: targets.artifactVersionId,
    });
    await seedRun(handle, targets);
    await seedRun(handle, { ...targets, suiteVersionId: unique.versionId });

    // Alone with its name: nothing is shared yet.
    expect((await listBenchmarkRuns(handle.db)).map((r) => r.suite.nameShared)).toEqual([
      false,
      false,
    ]);

    // A second suite with the same name, never run or assigned, makes the name shared everywhere.
    const twin = await importSuiteVersion(
      handle,
      suiteInput('t', { slug: 'safety-b', name: 'Safety' }),
    );
    const bySlug = (items: { slug: string; nameShared: boolean }[]) =>
      Object.fromEntries(items.map((s) => [s.slug, s.nameShared]));

    expect(bySlug((await listBenchmarkRuns(handle.db)).map((r) => r.suite))).toEqual({
      'safety-a': true,
      unique: false,
    });
    expect(
      bySlug((await listArtifactRuns(handle.db, targets.artifactId)).map((r) => r.suite)),
    ).toEqual({ 'safety-a': true, unique: false });
    const detail = await getArtifactDetail(handle.db, targets.artifactId);
    expect(bySlug(detail?.suites ?? [])).toEqual({ 'safety-a': true, unique: false });
    expect((await listJobs(handle.db))[0]).toMatchObject({
      suiteName: 'Safety',
      suiteSlug: 'safety-a',
      suiteNameShared: true,
    });
    const suites = await listSuites(handle.db);
    expect(Object.fromEntries(suites.map((s) => [s.suite.slug, s.nameShared]))).toEqual({
      'safety-a': true,
      'safety-b': true,
      unique: false,
    });
    expect(twin.suiteId).not.toBe(targets.suiteId);
  });
});

describe('artifact name shared', () => {
  it('flags an assigned artifact whose name another artifact has, assigned or not', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle, { artifact: { name: 'SKILL.md' } });
    const solo = await importArtifactVersion(
      handle,
      artifactInput('s', { slug: 'solo', name: 'solo', path: 'skills/solo' }),
    );
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);
    await assignBenchmarkSuite(handle.db, solo.artifactId, targets.suiteId);
    const shared = async () =>
      Object.fromEntries(
        ((await getSuiteDetail(handle.db, targets.suiteId))?.assignedArtifacts ?? []).map((a) => [
          a.slug,
          a.nameShared,
        ]),
      );
    expect(await shared()).toEqual({ validate: false, solo: false });

    await importArtifactVersion(
      handle,
      artifactInput('o', {
        slug: 'other-skill',
        name: 'SKILL.md',
        path: 'rules/SKILL.md',
        // The example import links an artifact of the same name and type, so another type.
        type: 'rule',
      }),
    );
    expect(await shared()).toEqual({ validate: true, solo: false });
  });
});

describe('category chip shared', () => {
  it('flags categories that show the same chip text, on the list and the artifact page', async () => {
    const handle = getHandle();
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    const first = await category(handle, 'Platform');
    // Active names are unique, archived ones are not; slugs stay unique, so the second one keeps
    // its own slug and gets the name by a rename after the first is archived.
    const second = await category(handle, 'Platform 2');
    const python = await category(handle, 'Python');
    for (const c of [first, second, python]) await assignArtifactCategory(handle, artifactId, c.id);
    await setCategoryArchived(handle, { id: first.id, state: 'archived' });
    await updateCategory(handle, { id: second.id, name: 'Platform', description: null });
    const chips = async () => {
      const listed = (await listArtifacts(handle.db))[0]?.categories ?? [];
      const detail = (await getArtifactDetail(handle.db, artifactId))?.categories ?? [];
      expect(detail).toEqual(listed);
      return Object.fromEntries(listed.map((c) => [c.slug, c.chipShared]));
    };

    // "Platform" and "Platform (archived)" read differently.
    expect(await chips()).toEqual({ platform: false, 'platform-2': false, python: false });

    // Two archived "Platform" chips read alike.
    await setCategoryArchived(handle, { id: second.id, state: 'archived' });
    expect(await chips()).toEqual({ platform: true, 'platform-2': true, python: false });

    // An active category literally named "Platform (archived)" reads like both of them.
    await updateCategory(handle, { id: python.id, name: 'Platform (archived)', description: null });
    expect(await chips()).toEqual({ platform: true, 'platform-2': true, python: true });
  });
});
