import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { parseArtifactFile } from '@directivebench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  addArtifactTag,
  applyRepositoryScan,
  assignArtifactSuite,
  assignCategoriesBySlug,
  enqueueRepositoryScanJob,
  finishJob,
  getArtifactBundle,
  getArtifactDetail,
  importArtifactVersion,
  importSuiteVersion,
  listArtifacts,
  registerHostedRepository,
  refreshSourceFields,
  removeRepository,
  resolveArtifactRef,
  schema,
  seedPredefinedCategories,
  setArtifactNotes,
  withTransaction,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { artifactInput, registerLocal, suiteInput } from './support/fixtures';
import { openTestDatabase, useTestDatabase } from './support/test-database';

// Issue 66 (SPEC-103 FR-103-16, §14; SPEC-101 §8.3, §14): what a rescan changes on an existing
// artifact. Identity keys on location and exact content, never on a name or a slug; `name`,
// `description` and `type` follow the chosen active occurrence (FR-126-07); a slug is an
// immutable handle that is never changed, freed or reused.

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

function tick() {
  clock += 1_000;
  vi.setSystemTime(clock);
}

function skillMd(name: string | null, body = 'Review the diff.', description = 'Reviews code') {
  return `---\n${name === null ? '' : `name: ${name}\n`}description: ${description}\n---\n${body}\n`;
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

/** A discovered single-file artifact (a rule or an instruction), parsed like discovery. */
function single(path: string, content: string): ScannedArtifactInput {
  const parsed = parseArtifactFile(path, content);
  const primaryFile = posix.basename(path);
  return {
    path,
    name: parsed.name,
    type: parsed.type,
    description: parsed.description,
    format: parsed.format,
    primaryFile,
    files: [{ path: primaryFile, content }],
    parsedMetadata: { frontmatter: parsed.frontmatter },
  };
}

async function local(handle: DatabaseHandle, name: string) {
  return (
    await registerLocal(handle, { location: `/srv/${name}`, name, provider: 'local-directory' })
  ).repository.id;
}

async function hosted(handle: DatabaseHandle, name: string) {
  return (
    await registerHostedRepository(handle.db, {
      provider: 'github',
      name,
      location: `https://github.com/acme/${name}`,
      defaultBranch: 'main',
    })
  ).repository.id;
}

/** One complete scan of a repository, as the runner applies it. */
async function scan(
  handle: DatabaseHandle,
  repositoryId: string,
  artifacts: ScannedArtifactInput[],
  commitSha: string | null = null,
) {
  tick();
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  await acquireNextJob(handle.db, 'runner');
  try {
    return await applyRepositoryScan(handle, {
      repositoryId,
      jobId: job.id,
      artifacts,
      unobserved: [],
      signal,
      commitSha,
    });
  } finally {
    await finishJob(handle.db, job.id, 'completed');
  }
}

/** Every artifact as `[slug, name, type, occurrences]`, ordered by slug. */
async function artifactRows(handle: DatabaseHandle) {
  const rows = await handle.db.select().from(schema.artifacts).orderBy(schema.artifacts.slug);
  const occurrences = await handle.db.select().from(schema.artifactOccurrences);
  return rows.map((row) => [
    row.slug,
    row.name,
    row.type,
    occurrences
      .filter((occurrence) => occurrence.artifactId === row.id)
      .map((occurrence) => `${occurrence.path}:${occurrence.status}`)
      .sort(),
  ]);
}

async function bySlug(handle: DatabaseHandle, slug: string) {
  const row = await handle.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.slug, slug))
    .get();
  if (!row) throw new Error(`no artifact ${slug}`);
  return row;
}

async function versionsOf(handle: DatabaseHandle, artifactId: string) {
  return handle.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifactId))
    .orderBy(schema.artifactVersions.version);
}

describe('renames keep the artifact and its slug (FR-103-16, SPEC-101 §8.3)', () => {
  it('follows an in-place frontmatter rename: same id, new name, same slug, metadata kept (test 1)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    const artifact = await bySlug(handle, 'review');
    await seedPredefinedCategories(handle.db);
    await assignCategoriesBySlug(handle.db, artifact.id, ['security']);
    await addArtifactTag(handle, artifact.id, 'kept-tag');
    await setArtifactNotes(handle.db, artifact.id, 'kept notes');
    const suite = await importSuiteVersion(handle, suiteInput('h'));
    await assignArtifactSuite(handle, artifact.id, suite.suiteId);

    await scan(handle, a, [skill('skills/review', skillMd('code-review'))]);
    const detail = await getArtifactDetail(handle.db, artifact.id);
    expect(detail).toMatchObject({
      artifact: {
        id: artifact.id,
        slug: 'review',
        name: 'code-review',
        notes: 'kept notes',
        tags: ['kept-tag'],
      },
      categories: [{ slug: 'security' }],
      suites: [{ id: suite.suiteId }],
    });
    expect((await versionsOf(handle, artifact.id)).map((v) => v.version)).toEqual([1, 2]);
    // The slug assigned at creation still names the artifact in the CLI (FR-118-22).
    expect(await resolveArtifactRef(handle.db, 'review')).toMatchObject({
      artifact: { id: artifact.id, slug: 'review', name: 'code-review' },
      version: { version: 2 },
    });
  });

  it('keeps the slug when a skill folder without a frontmatter name is renamed (test 2, §14 N9.9)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/lint', skillMd(null))]);
    const artifact = await bySlug(handle, 'lint');
    await scan(handle, a, [skill('skills/lint2', skillMd(null))]);
    expect(await artifactRows(handle)).toEqual([
      ['lint', 'lint2', 'skill', ['skills/lint2:active']],
    ]);
    expect((await bySlug(handle, 'lint')).id).toBe(artifact.id);
    expect(await versionsOf(handle, artifact.id)).toHaveLength(1);
  });

  it('keeps the slug when a single-file rule is renamed (test 3)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const rule = '---\nglobs: "*.ts"\n---\nUse named exports.\n';
    await scan(handle, a, [single('.cursor/rules/a.mdc', rule)]);
    const artifact = await bySlug(handle, 'a');
    await scan(handle, a, [single('.cursor/rules/b.mdc', rule)]);
    expect(await artifactRows(handle)).toEqual([
      ['a', 'b', 'rule', ['.cursor/rules/b.mdc:active']],
    ]);
    expect((await bySlug(handle, 'a')).id).toBe(artifact.id);
    expect(await versionsOf(handle, artifact.id)).toHaveLength(2);
  });

  it('makes a new artifact for a rename plus a content change elsewhere; the old slug is never reused (test 4, §14 N9.6)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    const old = await bySlug(handle, 'review');
    await scan(handle, a, [skill('skills/code-review', skillMd('code-review', 'Edited.'))]);
    expect(await artifactRows(handle)).toEqual([
      ['code-review', 'code-review', 'skill', ['skills/code-review:active']],
      ['review', 'review', 'skill', ['skills/review:removed']],
    ]);
    expect((await resolveArtifactRef(handle.db, 'review')).artifact.id).toBe(old.id);
    // A later artifact named like the missing one gets a suffix: the slug stays taken.
    await scan(handle, a, [
      skill('skills/code-review', skillMd('code-review', 'Edited.')),
      skill('other/review', skillMd('review', 'Another review.')),
    ]);
    expect((await bySlug(handle, 'review-2')).name).toBe('review');
    expect((await resolveArtifactRef(handle.db, 'review')).artifact.id).toBe(old.id);
  });

  it('keeps both slugs when two skills swap names; a later same-named one gets a suffix (test 7, §14 N9.1)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      skill('skills/one', skillMd('alpha', 'Alpha body.')),
      skill('skills/two', skillMd('beta', 'Beta body.')),
    ]);
    const alpha = await bySlug(handle, 'alpha');
    const beta = await bySlug(handle, 'beta');
    await scan(handle, a, [
      skill('skills/one', skillMd('beta', 'Alpha body.')),
      skill('skills/two', skillMd('alpha', 'Beta body.')),
    ]);
    expect(await artifactRows(handle)).toEqual([
      ['alpha', 'beta', 'skill', ['skills/one:active']],
      ['beta', 'alpha', 'skill', ['skills/two:active']],
    ]);
    expect((await bySlug(handle, 'alpha')).id).toBe(alpha.id);
    expect((await bySlug(handle, 'beta')).id).toBe(beta.id);
    // The names no longer clash, so the list needs no slug to tell them apart.
    expect((await listArtifacts(handle.db)).map((row) => row.nameShared)).toEqual([false, false]);
    await scan(handle, a, [
      skill('skills/one', skillMd('beta', 'Alpha body.')),
      skill('skills/two', skillMd('alpha', 'Beta body.')),
      skill('skills/three', skillMd('beta', 'A third skill.')),
    ]);
    expect((await bySlug(handle, 'beta-2')).name).toBe('beta');
  });

  it('keeps the slug when a skill is renamed to another artifact name; both are possible duplicates (§14 N9.2)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      skill('skills/review', skillMd('review', 'Review A.')),
      skill('skills/check', skillMd('check', 'Check B.')),
    ]);
    await scan(handle, a, [
      skill('skills/review', skillMd('review', 'Review A.')),
      skill('skills/check', skillMd('review', 'Check B.')),
    ]);
    expect(await artifactRows(handle)).toEqual([
      ['check', 'review', 'skill', ['skills/check:active']],
      ['review', 'review', 'skill', ['skills/review:active']],
    ]);
    const listed = await listArtifacts(handle.db);
    // Same-named rows are ordered by their random ids, so compare them sorted by slug.
    expect(listed.map((row) => [row.slug, row.nameShared, row.possibleDuplicates]).sort()).toEqual([
      ['check', true, 1],
      ['review', true, 1],
    ]);
  });

  it('never changes the slug of linked copies whose names diverge, in either scan order (test 8, §14 N9.7)', async () => {
    const run = async (order: 'ab' | 'ba') => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        const b = await local(handle, 'b');
        await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        await scan(handle, b, [skill('skills/review', skillMd('review'))]);
        const edits = {
          [a]: [skill('skills/review', skillMd('alpha'))],
          [b]: [skill('skills/review', skillMd('beta'))],
        };
        for (const id of order === 'ab' ? [a, b] : [b, a]) await scan(handle, id, edits[id]!);
        return (await artifactRows(handle)).map(([slug, name]) => [slug, name]);
      } finally {
        database.dispose();
      }
    };
    // The copy scanned last holds the highest version and names the artifact (FR-126-07).
    expect(await run('ab')).toEqual([['review', 'beta']]);
    expect(await run('ba')).toEqual([['review', 'alpha']]);
  });
});

describe('the type follows the source (FR-103-16, N1, N2)', () => {
  it('keeps the artifact when the same path changes format, and its type follows (test 5, §14 N9.4)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    // A file `docs/AGENTS.md`, later a directory `docs/AGENTS.md/` holding a skill.
    await scan(handle, a, [single('docs/AGENTS.md', '# Agents\n')]);
    const artifact = await bySlug(handle, 'docs-agents-md');
    expect(artifact.type).toBe('instruction');
    await scan(handle, a, [skill('docs/AGENTS.md', skillMd('docs-skill'))]);

    expect(await artifactRows(handle)).toEqual([
      ['docs-agents-md', 'docs-skill', 'skill', ['docs/AGENTS.md:active']],
    ]);
    const detail = await getArtifactDetail(handle.db, artifact.id);
    expect(detail?.artifact).toMatchObject({ id: artifact.id, type: 'skill' });
    expect(detail?.versions.map((v) => [v.version, v.format])).toEqual([
      [2, 'skill-md'],
      [1, 'agents-md'],
    ]);
    expect((await listArtifacts(handle.db, { type: 'skill' })).map((row) => row.id)).toEqual([
      artifact.id,
    ]);
    expect(await listArtifacts(handle.db, { type: 'instruction' })).toEqual([]);
    // A run's bundle takes the type of the bundled version's format (N2).
    const [v1, v2] = await versionsOf(handle, artifact.id);
    expect(await getArtifactBundle(handle.db, v1?.id ?? '')).toMatchObject({
      type: 'instruction',
      format: 'agents-md',
    });
    expect(await getArtifactBundle(handle.db, v2?.id ?? '')).toMatchObject({
      type: 'skill',
      format: 'skill-md',
    });
    // Back to the file: the old version is reused and the type follows again.
    await scan(handle, a, [single('docs/AGENTS.md', '# Agents\n')]);
    expect(await artifactRows(handle)).toEqual([
      ['docs-agents-md', 'docs/AGENTS.md', 'instruction', ['docs/AGENTS.md:active']],
    ]);
  });

  it('follows a type change in a hosted repository too (§14 N9.8)', async () => {
    const handle = getHandle();
    const g = await hosted(handle, 'g');
    await scan(handle, g, [single('docs/AGENTS.md', '# Agents\n')], 'c1');
    await scan(handle, g, [skill('docs/AGENTS.md', skillMd('docs-skill'))], 'c2');
    expect(await artifactRows(handle)).toEqual([
      ['docs-agents-md', 'docs-skill', 'skill', ['docs/AGENTS.md:active']],
    ]);
  });

  it('keeps the location over an exact copy of the new format elsewhere: no link (§14 N9.3)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    const content = skillMd('shared-skill');
    await scan(handle, b, [skill('skills/shared', content)]);
    await scan(handle, a, [single('docs/AGENTS.md', '# Agents\n')]);
    expect(await scan(handle, a, [skill('docs/AGENTS.md', content)])).toMatchObject({
      linkedOccurrences: 0,
      createdArtifacts: 0,
      createdVersions: 1,
    });
    expect(await artifactRows(handle)).toEqual([
      ['docs-agents-md', 'shared-skill', 'skill', ['docs/AGENTS.md:active']],
      ['shared-skill', 'shared-skill', 'skill', ['skills/shared:active']],
    ]);
    // Same name and the same linkable format: now shown as possible duplicates.
    expect(
      (await listArtifacts(handle.db)).map((row) => [row.slug, row.possibleDuplicates]).sort(),
    ).toEqual([
      ['docs-agents-md', 1],
      ['shared-skill', 1],
    ]);
  });

  it('makes a new artifact when equal bytes move into another format (test 6, §14 N9.5)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const rule = '---\nglobs: "*.ts"\n---\nUse named exports.\n';
    await scan(handle, a, [single('.cursor/rules/style.mdc', rule), single('CLAUDE.md', '# Hi\n')]);
    await scan(handle, a, [single('.claude/rules/style.md', rule), single('AGENTS.md', '# Hi\n')]);
    expect(await artifactRows(handle)).toEqual([
      ['agents-md', 'AGENTS.md', 'instruction', ['AGENTS.md:active']],
      ['claude-md', 'CLAUDE.md', 'instruction', ['CLAUDE.md:removed']],
      ['style', 'style', 'rule', ['.cursor/rules/style.mdc:removed']],
      ['style-2', 'style', 'rule', ['.claude/rules/style.md:active']],
    ]);
  });

  it('keeps the type of an artifact with no active occurrence (test 9)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      skill('docs/AGENTS.md', skillMd('docs-skill')),
      single('AGENTS.md', '# A'),
    ]);
    const artifact = await bySlug(handle, 'docs-skill');
    // A hand-made stale type is kept rather than guessed once nothing names the artifact.
    await handle.db
      .update(schema.artifacts)
      .set({ type: 'rule' })
      .where(eq(schema.artifacts.id, artifact.id));
    await scan(handle, a, [single('AGENTS.md', '# A')]);
    expect((await bySlug(handle, 'docs-skill')).type).toBe('rule');
  });

  it('writes the type even when the chosen version cannot be parsed for its name', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')]);
    const artifact = await bySlug(handle, 'review');
    await handle.db
      .update(schema.artifacts)
      .set({ type: 'rule', name: 'renamed by hand' })
      .where(eq(schema.artifacts.id, artifact.id));
    // A damaged row (no primary file) keeps its name, but its format still decides the type.
    handle.sqlite
      .prepare("update artifact_versions set files = '[]' where artifact_id = ?")
      .run(artifact.id);
    await scan(handle, a, [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')]);
    expect(await bySlug(handle, 'review')).toMatchObject({
      name: 'renamed by hand',
      type: 'skill',
    });
  });

  it('writes the type when the occurrence path does not classify as the version format, once', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      single('.cursor/rules/style.mdc', '---\nglobs: "*.ts"\n---\nUse it.\n'),
    ]);
    const artifact = await bySlug(handle, 'style');
    // Rows scans never write: a Cursor rule occurrence at a path that is not a Cursor rule.
    handle.sqlite
      .prepare("update artifact_occurrences set path = 'notes/x.txt' where artifact_id = ?")
      .run(artifact.id);
    handle.sqlite
      .prepare(
        "update artifacts set type = 'skill', name = 'kept', updated_at = 'old' where id = ?",
      )
      .run(artifact.id);
    await withTransaction(handle, (db) => refreshSourceFields(db, [artifact.id]));
    const refreshed = await bySlug(handle, 'style');
    // The name cannot be parsed from that path and is kept; the stored format decides the type.
    expect(refreshed).toMatchObject({ type: 'rule', name: 'kept' });
    expect(refreshed.updatedAt).not.toBe('old');
    // A second refresh with nothing to change writes nothing.
    tick();
    await withTransaction(handle, (db) => refreshSourceFields(db, [artifact.id]));
    expect((await bySlug(handle, 'style')).updatedAt).toBe(refreshed.updatedAt);
  });

  it('reverts the type when the repository holding the highest version is removed (FR-126-23)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    const rule = '---\nglobs: "*.ts"\n---\nUse named exports.\n';
    // One artifact in two repositories: the same named rule linked (rule 3), then repository B
    // replaces it with a skill at the same path (rule 1), which holds the highest version.
    await scan(handle, a, [single('.cursor/rules/style.mdc', rule)]);
    await scan(handle, b, [single('.cursor/rules/style.mdc', rule)]);
    await scan(handle, b, [skill('.cursor/rules/style.mdc', skillMd('style'))]);
    expect(await artifactRows(handle)).toEqual([
      [
        'style',
        'style',
        'skill',
        ['.cursor/rules/style.mdc:active', '.cursor/rules/style.mdc:active'],
      ],
    ]);
    await removeRepository(handle, b);
    expect(await artifactRows(handle)).toEqual([
      ['style', 'style', 'rule', ['.cursor/rules/style.mdc:active']],
    ]);
  });

  it('lets a bundled example take the type of its new format, keeping its slug (test 10, §14 N9.10)', async () => {
    const handle = getHandle();
    const bundled = {
      repository: {
        provider: 'bundled-examples' as const,
        name: 'Bundled',
        location: '/opt/examples',
      },
    };
    const guide = '# Guide\n';
    const first = await importArtifactVersion(
      handle,
      artifactInput(guide, {
        ...bundled,
        path: 'examples/guide/AGENTS.md',
        slug: 'guide',
        name: 'guide',
        type: 'instruction',
        format: 'agents-md',
        primaryFile: 'AGENTS.md',
        files: [{ path: 'AGENTS.md', sha256: '', size: 0, content: guide }],
      }),
    );
    const second = await importArtifactVersion(
      handle,
      artifactInput(skillMd('guide'), {
        ...bundled,
        path: 'examples/guide/AGENTS.md',
        slug: 'guide',
        name: 'guide',
        type: 'skill',
        format: 'skill-md',
      }),
    );
    expect(second.artifactId).toBe(first.artifactId);
    expect(await bySlug(handle, 'guide')).toMatchObject({ id: first.artifactId, type: 'skill' });
  });
});
