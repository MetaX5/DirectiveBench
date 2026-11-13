import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { parseArtifactFile } from '@directivebench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  addArtifactTag,
  applyRepositoryScan,
  ArtifactStoreError,
  assignArtifactSuite,
  assignCategoriesBySlug,
  enqueueRepositoryScanJob,
  finishJob,
  getArtifactDetail,
  IDENTITY_LOOKUP_BATCH_SIZE,
  importArtifactVersion,
  importSuiteVersion,
  listArtifacts,
  MAX_LISTED_DUPLICATES,
  POSSIBLE_DUPLICATE_FORMATS,
  registerHostedRepository,
  removeRepository,
  repositoryScanResultSchema,
  schema,
  seedPredefinedCategories,
  setArtifactNotes,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { artifactInput, registerLocal, seedRun, suiteInput } from './support/fixtures';
import { openTestDatabase, useTestDatabase } from './support/test-database';
import { expectLinearTime, LINEAR_TIME_TEST_TIMEOUT_MS } from '../../../test-support/linear-time';

// SPEC-126 Phase 1: exact copies of skills with a frontmatter `name` and of named rules in local
// repositories link to one artifact (rule 3), versions record their parent (lineage), and an
// artifact's name and description follow its active occurrences (FR-126-07, FR-126-23).

const getHandle = useTestDatabase();
const signal = new AbortController().signal;
/** Thousands of linked skills per scan; well under a second each locally. */
const MANY_ARTIFACTS_TIMEOUT_MS = 60_000;

let clock = Date.parse('2026-05-01T00:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.parse('2026-05-01T00:00:00.000Z');
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Moves the fake clock on, so every scan has its own `created_at` (A7 orders by it). */
function tick() {
  clock += 1_000;
  vi.setSystemTime(clock);
}

/** A `SKILL.md` with an optional frontmatter `name`. */
function skillMd(name: string | null, body = 'Review the diff.', description = 'Reviews code') {
  return `---\n${name === null ? '' : `name: ${name}\n`}description: ${description}\n---\n${body}\n`;
}

/** A discovered skill as the runner stores it (`toScannedArtifact`), parsed like discovery. */
function skill(
  dir: string,
  content: string,
  extra: { path: string; content: string }[] = [],
): ScannedArtifactInput {
  const parsed = parseArtifactFile(dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`, content);
  return {
    path: dir,
    name: parsed.name,
    type: parsed.type,
    description: parsed.description,
    format: parsed.format,
    primaryFile: 'SKILL.md',
    files: [{ path: 'SKILL.md', content }, ...extra].sort((a, b) => (a.path < b.path ? -1 : 1)),
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

async function local(
  handle: DatabaseHandle,
  name: string,
  provider: 'local-git' | 'local-directory' = 'local-directory',
) {
  return (await registerLocal(handle, { location: `/srv/${name}`, name, provider })).repository.id;
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

/** One complete scan of a repository, as the runner applies it, with its job finished after. */
async function scan(
  handle: DatabaseHandle,
  repositoryId: string,
  artifacts: ScannedArtifactInput[],
  commitSha: string | null = null,
  unobserved: string[] = [],
) {
  tick();
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  await acquireNextJob(handle.db, 'runner');
  try {
    return await applyRepositoryScan(handle, {
      repositoryId,
      jobId: job.id,
      artifacts,
      unobserved,
      signal,
      commitSha,
    });
  } finally {
    await finishJob(handle.db, job.id, 'completed');
  }
}

/** Every artifact with its versions and occurrences, without ids: equal for equal identities. */
async function snapshot(handle: DatabaseHandle) {
  const { db } = handle;
  const rows = await db.select().from(schema.artifacts).orderBy(schema.artifacts.slug);
  const versions = await db.select().from(schema.artifactVersions);
  const occurrences = await db
    .select({ occurrence: schema.artifactOccurrences, repository: schema.repositories.name })
    .from(schema.artifactOccurrences)
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.artifactOccurrences.repositoryId),
    );
  const number = new Map(versions.map((v) => [v.id, v.version]));
  return rows.map((artifact) => ({
    slug: artifact.slug,
    name: artifact.name,
    description: artifact.description,
    versions: versions
      .filter((v) => v.artifactId === artifact.id)
      .map((v) => `v${v.version}:${v.contentHash.slice(0, 8)}`)
      .sort(),
    occurrences: occurrences
      .filter(({ occurrence }) => occurrence.artifactId === artifact.id)
      .map(
        ({ occurrence, repository }) =>
          `${repository}:${occurrence.path}@v${number.get(occurrence.latestVersionId)}:${occurrence.status}`,
      )
      .sort(),
  }));
}

async function onlyArtifact(handle: DatabaseHandle) {
  const [row, ...rest] = await handle.db.select().from(schema.artifacts);
  expect(rest).toEqual([]);
  if (!row) throw new Error('no artifact');
  return row;
}

async function versionsOf(handle: DatabaseHandle, artifactId: string) {
  return handle.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifactId))
    .orderBy(schema.artifactVersions.version);
}

const none = {
  createdArtifacts: 0,
  createdVersions: 0,
  removedOccurrences: 0,
  reactivatedOccurrences: 0,
  emptyScanKeptOccurrences: 0,
  linkedOccurrences: 0,
  ambiguousLinks: 0,
  movedOccurrences: 0,
  ambiguousMoves: 0,
};

describe('rule 3: exact copies link (SPEC-126 FR-126-01 to FR-126-06)', () => {
  it('links an identical skill in a second repository: one artifact, one version, two occurrences (AC-1)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b', 'local-git');
    expect(await scan(handle, a, [skill('.claude/skills/review', skillMd('review'))])).toEqual({
      ...none,
      createdArtifacts: 1,
      createdVersions: 1,
    });
    expect(await scan(handle, b, [skill('skills/review', skillMd('review'))])).toEqual({
      ...none,
      linkedOccurrences: 1,
    });
    expect(await snapshot(handle)).toEqual([
      {
        slug: 'review',
        name: 'review',
        description: 'Reviews code',
        versions: [expect.stringMatching(/^v1:/)],
        occurrences: ['a:.claude/skills/review@v1:active', 'b:skills/review@v1:active'],
      },
    ]);
    const [item] = await listArtifacts(handle.db);
    expect(item).toMatchObject({
      occurrenceCount: 2,
      repositories: [{ name: 'a' }, { name: 'b' }],
      missing: false,
    });
    // A rescan of the linked copy is rule 1: nothing new.
    expect(await scan(handle, b, [skill('skills/review', skillMd('review'))])).toEqual(none);
  });

  it('links identical copies within one repository and within one scan (FR-126-04)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    expect(
      await scan(handle, a, [
        skill('.claude/skills/review', skillMd('review')),
        skill('.agents/skills/review', skillMd('review')),
      ]),
    ).toEqual({ ...none, createdArtifacts: 1, createdVersions: 1, linkedOccurrences: 1 });
    expect(
      await scan(handle, a, [
        skill('.claude/skills/review', skillMd('review')),
        skill('.agents/skills/review', skillMd('review')),
        skill('tools/review', skillMd('review')),
      ]),
    ).toEqual({ ...none, linkedOccurrences: 1 });
    expect((await snapshot(handle))[0]?.occurrences).toEqual([
      'a:.agents/skills/review@v1:active',
      'a:.claude/skills/review@v1:active',
      'a:tools/review@v1:active',
    ]);
  });

  it('gives the same artifacts in either repository scan order (G4)', async () => {
    const run = async (order: 'ab' | 'ba') => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        const b = await local(handle, 'b');
        const contents = {
          [a]: [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')],
          [b]: [skill('x/review', skillMd('review')), single('AGENTS.md', '# A')],
        };
        for (const id of order === 'ab' ? [a, b] : [b, a]) await scan(handle, id, contents[id]!);
        return (await snapshot(handle)).map(({ slug: _slug, ...rest }) => rest);
      } finally {
        database.dispose();
      }
    };
    const ab = await run('ab');
    expect(ab).toHaveLength(3);
    expect(await run('ba')).toEqual(expect.arrayContaining(ab));
  });

  it('links to the oldest of several candidates and counts the choice (A7, FR-126-03)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const c = await local(handle, 'c');
    const d = await local(handle, 'd');
    // Legacy duplicates: two artifacts that both hold the same content (here the A21 split).
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, c, [skill('skills/review', skillMd('review', 'Other'))]);
    await scan(handle, c, [skill('skills/review', skillMd('review'))]);
    expect((await snapshot(handle)).map((row) => row.slug)).toEqual(['review', 'review-2']);
    expect(await scan(handle, d, [skill('skills/review', skillMd('review'))])).toEqual({
      ...none,
      linkedOccurrences: 1,
      ambiguousLinks: 1,
    });
    expect((await snapshot(handle)).map((row) => row.occurrences)).toEqual([
      ['a:skills/review@v1:active', 'd:skills/review@v1:active'],
      ['c:skills/review@v2:active'],
    ]);
  });

  it('links the named rule formats and never instructions, Duo chat rules or skills named by their directory (A2, A3, AC-6)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    const found = [
      single('.cursor/rules/style.mdc', '---\nglobs: "*.ts"\n---\nUse tabs.\n'),
      single('.claude/rules/tests.md', 'Write tests.\n'),
      single('.github/instructions/api.instructions.md', '---\napplyTo: "api/**"\n---\nREST\n'),
      single('AGENTS.md', '@CLAUDE.md\n'),
      single('CLAUDE.md', '# Rules\n'),
      single('.github/copilot-instructions.md', '# Copilot\n'),
      single('.gitlab/duo/chat-rules.md', '# Duo\n'),
      skill('skills/anon', skillMd(null)),
      skill('skills/blank', skillMd('"  "')),
    ];
    await scan(handle, a, found);
    expect(await scan(handle, b, found)).toEqual({
      ...none,
      createdArtifacts: 6,
      createdVersions: 6,
      linkedOccurrences: 3,
    });
    const linked = (await snapshot(handle)).filter((row) => row.occurrences.length === 2);
    expect(linked.map((row) => row.name).sort()).toEqual(['api', 'style', 'tests']);
  });

  it('breaks a tie between candidates of the same age by id, and never links a skill without its SKILL.md', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const c = await local(handle, 'c');
    const d = await local(handle, 'd');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, c, [skill('skills/review', skillMd('review', 'Other'))]);
    await scan(handle, c, [skill('skills/review', skillMd('review'))]);
    handle.sqlite.exec("update artifacts set created_at = '2026-01-01T00:00:00.000Z'");
    const [first] = await handle.db.select().from(schema.artifacts).orderBy(schema.artifacts.id);
    await scan(handle, d, [skill('skills/review', skillMd('review'))]);
    const detail = await getArtifactDetail(handle.db, first?.id ?? '');
    expect(detail?.occurrences.map((o) => o.repository.name)).toContain('d');

    // Synthetic input whose files lack the primary file: not linkable (no name to compare).
    const broken = { ...skill('other/review', skillMd('review')), primaryFile: 'README.md' };
    expect(
      await scan(handle, d, [skill('skills/review', skillMd('review')), broken]),
    ).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
  });

  it('does not link equal content of another format', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    const rule = single('.claude/rules/SKILLS.md', skillMd('review'));
    await scan(handle, a, [rule]);
    // Same files and so the same content hash, but stored as another (linkable) format.
    const other = { ...rule, path: '.cursor/rules/SKILLS.mdc', format: 'cursor-rule' as const };
    expect(await scan(handle, b, [other])).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
  });

  it('links a copy that differs only in skipped files (A20)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    const withBinary = skill('skills/review', skillMd('review'));
    withBinary.parsedMetadata = { skipped: [{ path: 'logo.png', reason: 'binary' }] };
    expect(await scan(handle, b, [withBinary])).toMatchObject({ linkedOccurrences: 1 });
  });

  it('never links copies in hosted repositories, nor a local copy to an artifact with a hosted occurrence (A16, AC-6)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const g = await hosted(handle, 'g');
    const h = await hosted(handle, 'h');
    const sha = 'a'.repeat(40);
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    expect(await scan(handle, g, [skill('skills/review', skillMd('review'))], sha)).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
    expect(await scan(handle, h, [skill('skills/review', skillMd('review'))], sha)).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
    // A local copy of content only a hosted artifact holds is not linked to it either.
    await scan(handle, g, [skill('skills/lint', skillMd('lint'))], sha);
    expect(
      await scan(handle, a, [
        skill('skills/review', skillMd('review')),
        skill('skills/lint', skillMd('lint')),
      ]),
    ).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
    expect((await snapshot(handle)).map((row) => row.occurrences)).toEqual([
      ['g:skills/lint@v1:active'],
      ['a:skills/lint@v1:active'],
      ['a:skills/review@v1:active'],
      ['g:skills/review@v1:removed'],
      ['h:skills/review@v1:active'],
    ]);
  });

  it('keeps bundled examples apart in both orders (A5, FR-126-05, AC-4)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const demo = skillMd('validate');
    const bundled = artifactInput(demo, {
      repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/examples' },
      path: 'examples/skills/validate',
    });
    await importArtifactVersion(handle, bundled);
    expect(await scan(handle, a, [skill('skills/validate', demo)])).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
    // The import after a scanned copy keeps its own artifact too.
    const b = await local(handle, 'b');
    await scan(handle, b, [skill('skills/check', skillMd('check'))]);
    await importArtifactVersion(handle, {
      ...bundled,
      files: [{ path: 'SKILL.md', content: skillMd('check') }],
    });
    expect((await snapshot(handle)).map((row) => [row.slug, row.occurrences])).toEqual([
      ['check', ['b:skills/check@v1:active']],
      ['validate', ['Bundled:examples/skills/validate@v2:active']],
      ['validate-2', ['a:skills/validate@v1:active']],
    ]);
  });

  it('links to an artifact whose only occurrence is missing, but not to one with no occurrence left (A4)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')]);
    await scan(handle, a, [single('AGENTS.md', '# A')]);
    const [review] = (await listArtifacts(handle.db)).filter((row) => row.name === 'review');
    expect(review?.missing).toBe(true);
    expect(await scan(handle, b, [skill('skills/review', skillMd('review'))])).toMatchObject({
      linkedOccurrences: 1,
    });
    // Found again elsewhere: no longer missing (FR-126-08).
    expect((await getArtifactDetail(handle.db, review?.id ?? ''))?.missing).toBe(false);

    // Both repositories removed: the artifact has no occurrence and is not a candidate.
    await removeRepository(handle, a);
    await removeRepository(handle, b);
    const c = await local(handle, 'c');
    expect(await scan(handle, c, [skill('skills/review', skillMd('review'))])).toMatchObject({
      createdArtifacts: 1,
      linkedOccurrences: 0,
    });
  });

  it('links a copy of an older version after a rename, at that version (A2, §14)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, a, [skill('skills/review', skillMd('reviewer'))]);
    expect(await scan(handle, b, [skill('skills/review', skillMd('review'))])).toMatchObject({
      linkedOccurrences: 1,
    });
    const artifact = await onlyArtifact(handle);
    expect(artifact.name).toBe('reviewer');
    const detail = await getArtifactDetail(handle.db, artifact.id);
    expect(detail?.occurrences.map((o) => [o.repository.name, o.version])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('keeps categories, tags, notes, suite assignments, versions and runs when linking (FR-126-08, AC-5)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    const artifact = await onlyArtifact(handle);
    await seedPredefinedCategories(handle.db);
    await assignCategoriesBySlug(handle.db, artifact.id, ['security']);
    await addArtifactTag(handle, artifact.id, 'shared');
    await setArtifactNotes(handle.db, artifact.id, 'Copied to client B.');
    const suite = await importSuiteVersion(handle, suiteInput('h'));
    await assignArtifactSuite(handle, artifact.id, suite.suiteId);
    const [version] = await versionsOf(handle, artifact.id);
    const runId = await seedRun(handle, {
      artifactVersionId: version?.id ?? '',
      suiteVersionId: suite.versionId,
    });
    const before = await getArtifactDetail(handle.db, artifact.id);

    await scan(handle, b, [skill('skills/review', skillMd('review'))]);
    const after = await getArtifactDetail(handle.db, artifact.id);
    expect(after).toMatchObject({
      artifact: { tags: ['shared'], notes: 'Copied to client B.' },
      categories: [{ slug: 'security' }],
      suites: [{ id: suite.suiteId }],
      evaluations: [{ runId }],
    });
    expect(after?.versions).toEqual(before?.versions);
    expect(after?.occurrences).toHaveLength(2);
  });

  it('identifies the same input the same way in any discovery order (FR-126-24)', async () => {
    const found = [
      skill('c/review', skillMd('review', 'Different')),
      skill('b/review', skillMd('review')),
      skill('a/review', skillMd('review')),
      single('AGENTS.md', '# A'),
      single('x/AGENTS.md', '# A'),
    ];
    const run = async (order: ScannedArtifactInput[]) => {
      const database = await openTestDatabase();
      try {
        const id = await local(database.handle, 'a');
        const summary = await scan(database.handle, id, order);
        return { summary, artifacts: await snapshot(database.handle) };
      } finally {
        database.dispose();
      }
    };
    const sorted = await run([...found].reverse());
    expect(sorted.artifacts.map((row) => [row.slug, row.occurrences])).toEqual([
      ['agents-md', ['a:AGENTS.md@v1:active']],
      ['review', ['a:a/review@v1:active', 'a:b/review@v1:active']],
      ['review-2', ['a:c/review@v1:active']],
      ['x-agents-md', ['a:x/AGENTS.md@v1:active']],
    ]);
    for (const order of [found, [found[2]!, found[0]!, found[4]!, found[1]!, found[3]!]]) {
      expect(await run(order)).toEqual(sorted);
    }
  });

  it('splits an edit copied before its source is rescanned, and links it the other way round (A21, AC-10)', async () => {
    const run = async (order: 'source-first' | 'copy-first') => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        const b = await local(handle, 'b');
        await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        const edited = skill('skills/review', skillMd('review', 'Edited.'));
        if (order === 'source-first') {
          await scan(handle, a, [edited]);
          await scan(handle, b, [edited]);
        } else {
          await scan(handle, b, [edited]);
          await scan(handle, a, [edited]);
        }
        return (await snapshot(handle)).map((row) => [row.slug, row.occurrences]);
      } finally {
        database.dispose();
      }
    };
    expect(await run('source-first')).toEqual([
      ['review', ['a:skills/review@v2:active', 'b:skills/review@v2:active']],
    ]);
    expect(await run('copy-first')).toEqual([
      ['review', ['a:skills/review@v2:active']],
      ['review-2', ['b:skills/review@v1:active']],
    ]);
  });

  it('rolls back the whole scan when a link fails and names the path (§13)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    handle.sqlite.exec(
      "create trigger fail_link before insert on artifact_occurrences when new.path = 'z/review' begin select raise(abort, 'link refused'); end",
    );
    const before = await snapshot(handle);
    const failure = await scan(handle, b, [
      skill('a/lint', skillMd('lint')),
      skill('z/review', skillMd('review')),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({ path: 'z/review' });
    expect(await snapshot(handle)).toEqual(before);
  });

  it(
    'reads the candidates in one statement per IDENTITY_LOOKUP_BATCH_SIZE hashes (NFR-126-01)',
    async () => {
      const handle = getHandle();
      const a = await local(handle, 'a');
      const b = await local(handle, 'b');
      const count = IDENTITY_LOOKUP_BATCH_SIZE * 2 + 1;
      const skills = Array.from({ length: count }, (_, i) =>
        skill(`skills/s${String(i).padStart(4, '0')}`, skillMd(`s${i}`)),
      );
      await scan(handle, a, skills);
      const prepare = vi.spyOn(handle.sqlite, 'prepare');
      const summary = await scan(handle, b, skills);
      const statements = prepare.mock.calls.map(([query]) => query);
      prepare.mockRestore();
      // The seam fired: every path was linked through the batched read.
      expect(summary).toMatchObject({ linkedOccurrences: count, createdArtifacts: 0 });
      const candidateReads = statements.filter(
        (query) => query.includes('not exists') && query.includes('"content_hash" in'),
      );
      expect(candidateReads).toHaveLength(3);
      const refreshReads = statements.filter(
        (query) =>
          query.startsWith('select') &&
          query.includes('from "artifact_occurrences" inner join "artifact_versions"') &&
          query.includes('"artifact_occurrences"."artifact_id" in'),
      );
      expect(refreshReads).toHaveLength(3);
    },
    MANY_ARTIFACTS_TIMEOUT_MS,
  );

  it(
    'links thousands of skills in linear time (NFR-126-04)',
    async () => {
      const built: { dispose(): void }[] = [];
      try {
        const build = async (size: number) => {
          const database = await openTestDatabase();
          built.push(database);
          const { handle } = database;
          const a = await local(handle, 'a');
          const b = await local(handle, 'b');
          const skills = Array.from({ length: size }, (_, i) =>
            skill(`skills/s${i}`, skillMd(`s${i}`)),
          );
          await scan(handle, a, skills);
          return { handle, a, b, skills };
        };
        await expectLinearTime({
          build,
          // Link every skill into B, then drop B's occurrences so the next call links again.
          run: async ({ handle, b, skills }) => {
            await scan(handle, b, skills);
            handle.sqlite
              .prepare('delete from artifact_occurrences where repository_id = ?')
              .run(b);
          },
          // A rescan of A: the same discovered input through rule 1, known to be linear.
          baseline: ({ handle, a, skills }) => scan(handle, a, skills),
          size: 3_200,
        });
      } finally {
        for (const database of built) database.dispose();
      }
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});

describe('rule 2: moves keep identity (SPEC-126 FR-126-14 to FR-126-18, AC-3)', () => {
  /** Every occurrence of a repository: id, path, status and the version number it holds. */
  async function occurrencesOf(handle: DatabaseHandle, repositoryId: string) {
    const rows = await handle.db
      .select({
        id: schema.artifactOccurrences.id,
        artifactId: schema.artifactOccurrences.artifactId,
        path: schema.artifactOccurrences.path,
        status: schema.artifactOccurrences.status,
        version: schema.artifactVersions.version,
      })
      .from(schema.artifactOccurrences)
      .innerJoin(
        schema.artifactVersions,
        eq(schema.artifactVersions.id, schema.artifactOccurrences.latestVersionId),
      )
      .where(eq(schema.artifactOccurrences.repositoryId, repositoryId));
    return rows.sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  it('moves a skill directory without a frontmatter name: same occurrence, artifact and version, new path and name', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a', 'local-git');
    await scan(handle, a, [
      skill('.claude/skills/review', skillMd(null)),
      skill('.claude/skills/lint', skillMd(null, 'Lint it.')),
    ]);
    const [, before] = await occurrencesOf(handle, a);
    if (!before) throw new Error('no occurrence');
    await setArtifactNotes(handle.db, before.artifactId, 'kept notes');
    await addArtifactTag(handle, before.artifactId, 'kept-tag');

    expect(
      await scan(handle, a, [
        skill('.agents/skills/code-review', skillMd(null)),
        skill('.claude/skills/lint', skillMd(null, 'Lint it.')),
      ]),
    ).toEqual({ ...none, movedOccurrences: 1 });

    const after = await occurrencesOf(handle, a);
    expect(after).toEqual([
      {
        id: before.id,
        artifactId: before.artifactId,
        path: '.agents/skills/code-review',
        status: 'active',
        version: 1,
      },
      expect.objectContaining({ path: '.claude/skills/lint', status: 'active' }),
    ]);
    const detail = await getArtifactDetail(handle.db, before.artifactId);
    // The name follows the new directory (FR-126-07, H9); the slug never changes (FR-105-13).
    expect(detail?.artifact).toMatchObject({
      name: 'code-review',
      slug: 'review',
      notes: 'kept notes',
      tags: ['kept-tag'],
    });
    expect(await versionsOf(handle, before.artifactId)).toHaveLength(1);
  });

  it('renames a single-file rule: same occurrence, the next version with the old one as parent (A13)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const rule = '---\ndescription: No default exports\nglobs: "*.ts"\n---\nUse named exports.\n';
    await scan(handle, a, [single('.cursor/rules/no-default-export.mdc', rule)]);
    const [before] = await occurrencesOf(handle, a);
    if (!before) throw new Error('no occurrence');

    expect(await scan(handle, a, [single('.cursor/rules/no-default-exports.mdc', rule)])).toEqual({
      ...none,
      movedOccurrences: 1,
      createdVersions: 1,
    });
    expect(await occurrencesOf(handle, a)).toEqual([
      { ...before, path: '.cursor/rules/no-default-exports.mdc', version: 2 },
    ]);
    const [v1, v2] = await versionsOf(handle, before.artifactId);
    expect(v2).toMatchObject({
      parentVersionId: v1?.id,
      sourcePath: '.cursor/rules/no-default-exports.mdc',
    });
    expect((await onlyArtifact(handle)).name).toBe('no-default-exports');
  });

  it('moves an instruction file and keeps its version when the file name stays', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [single('docs/AGENTS.md', '# Agents\n')]);
    expect(await scan(handle, a, [single('packages/app/AGENTS.md', '# Agents\n')])).toEqual({
      ...none,
      movedOccurrences: 1,
    });
    expect(await snapshot(handle)).toEqual([
      expect.objectContaining({ occurrences: ['a:packages/app/AGENTS.md@v1:active'] }),
    ]);
  });

  it('does not move two identical skills moved at once; both old rows go missing (§11.5 H2)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/x', skillMd(null)), skill('skills/y', skillMd(null))]);
    expect(
      await scan(handle, a, [skill('moved/x', skillMd(null)), skill('moved/y', skillMd(null))]),
    ).toEqual({
      ...none,
      ambiguousMoves: 2,
      removedOccurrences: 2,
      // Skills without a frontmatter name never link (A2): two new artifacts.
      createdArtifacts: 2,
      createdVersions: 2,
    });
    expect((await occurrencesOf(handle, a)).map((o) => [o.path, o.status])).toEqual([
      ['moved/x', 'active'],
      ['moved/y', 'active'],
      ['skills/x', 'removed'],
      ['skills/y', 'removed'],
    ]);
  });

  it('links identical named skills moved at once to their artifact through rule 3 (A12)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      skill('skills/x', skillMd('review')),
      skill('skills/y', skillMd('review')),
    ]);
    expect(
      await scan(handle, a, [
        skill('moved/x', skillMd('review')),
        skill('moved/y', skillMd('review')),
      ]),
    ).toEqual({ ...none, ambiguousMoves: 2, removedOccurrences: 2, linkedOccurrences: 2 });
    expect(await snapshot(handle)).toEqual([
      expect.objectContaining({
        slug: 'review',
        occurrences: [
          'a:moved/x@v1:active',
          'a:moved/y@v1:active',
          'a:skills/x@v1:removed',
          'a:skills/y@v1:removed',
        ],
      }),
    ]);
  });

  it('counts the new paths of a move plus a copy, and of two deletions with one addition', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('x', skillMd(null)), skill('keep', skillMd(null, 'Keep.'))]);
    expect(
      await scan(handle, a, [
        skill('y', skillMd(null)),
        skill('z', skillMd(null)),
        skill('keep', skillMd(null, 'Keep.')),
      ]),
    ).toMatchObject({ ambiguousMoves: 2, movedOccurrences: 0, removedOccurrences: 1 });

    const b = await local(handle, 'b');
    await scan(handle, b, [skill('p', skillMd(null)), skill('q', skillMd(null))]);
    expect(await scan(handle, b, [skill('r', skillMd(null))])).toMatchObject({
      ambiguousMoves: 1,
      movedOccurrences: 0,
      removedOccurrences: 2,
    });
  });

  it('applies the one-to-one pairs and leaves an ambiguous group apart in the same scan', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      skill('x', skillMd(null)),
      skill('y', skillMd(null)),
      single('.cursor/rules/a.mdc', 'Rule A.\n'),
    ]);
    expect(
      await scan(handle, a, [
        skill('x2', skillMd(null)),
        skill('y2', skillMd(null)),
        single('.cursor/rules/b.mdc', 'Rule A.\n'),
      ]),
    ).toEqual({
      ...none,
      movedOccurrences: 1,
      createdVersions: 3,
      ambiguousMoves: 2,
      createdArtifacts: 2,
      removedOccurrences: 2,
    });
  });

  it('never matches a different format, a different content or a missing occurrence', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [
      single('.cursor/rules/a.mdc', 'Same text.\n'),
      skill('skills/x', skillMd(null)),
      skill('skills/keep', skillMd(null, 'Keep.')),
    ]);
    // The rule becomes a Claude rule with the same bytes, the skill changes content.
    expect(
      await scan(handle, a, [
        single('.claude/rules/a.md', 'Same text.\n'),
        skill('skills/x2', skillMd(null, 'Changed.')),
        skill('skills/keep', skillMd(null, 'Keep.')),
      ]),
    ).toMatchObject({ movedOccurrences: 0, ambiguousMoves: 0, removedOccurrences: 2 });
    // A missing occurrence never moves (FR-126-14: active unseen occurrences only, §11.5 H7).
    expect(
      await scan(handle, a, [
        skill('skills/x3', skillMd(null)),
        skill('skills/keep', skillMd(null, 'Keep.')),
      ]),
    ).toMatchObject({ movedOccurrences: 0, ambiguousMoves: 0, createdArtifacts: 1 });
  });

  it('never moves an occurrence under an unobserved path, and moves nothing in an empty scan', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/x', skillMd(null)), skill('keep', skillMd(null, 'K.'))]);
    expect(
      await scan(
        handle,
        a,
        [skill('moved/x', skillMd(null)), skill('keep', skillMd(null, 'K.'))],
        null,
        ['skills'],
      ),
    ).toMatchObject({ movedOccurrences: 0, createdArtifacts: 1, removedOccurrences: 0 });
    expect(await scan(handle, a, [])).toEqual({ ...none, emptyScanKeptOccurrences: 3 });
  });

  it('reactivates a missing row at the target path instead of moving (rule 1 first, §14)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('old', skillMd(null)), skill('keep', skillMd(null, 'K.'))]);
    await scan(handle, a, [skill('keep', skillMd(null, 'K.'))]);
    await scan(handle, a, [skill('new', skillMd(null)), skill('keep', skillMd(null, 'K.'))]);
    // `new` exists now (a new artifact, `old` is missing); move it back over `old`'s row.
    expect(
      await scan(handle, a, [skill('old', skillMd(null)), skill('keep', skillMd(null, 'K.'))]),
    ).toMatchObject({ reactivatedOccurrences: 1, removedOccurrences: 1, movedOccurrences: 0 });
    expect((await occurrencesOf(handle, a)).map((o) => [o.path, o.status])).toEqual([
      ['keep', 'active'],
      ['new', 'removed'],
      ['old', 'active'],
    ]);
  });

  it('moves in a GitHub repository too (rule 2 is not limited to local repositories)', async () => {
    const handle = getHandle();
    const g = await hosted(handle, 'g');
    await scan(handle, g, [skill('skills/review', skillMd('review'))], 'a'.repeat(40));
    const [before] = await occurrencesOf(handle, g);
    expect(
      await scan(handle, g, [skill('.agents/skills/review', skillMd('review'))], 'b'.repeat(40)),
    ).toEqual({ ...none, movedOccurrences: 1 });
    const rows = await handle.db.select().from(schema.artifactOccurrences);
    expect(rows).toEqual([
      expect.objectContaining({
        id: before?.id,
        path: '.agents/skills/review',
        commitSha: 'b'.repeat(40),
      }),
    ]);
  });

  it('gives the same identities in any discovery order', async () => {
    const run = async (reverse: boolean) => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        await scan(handle, a, [
          skill('x', skillMd(null)),
          single('.cursor/rules/a.mdc', 'A.\n'),
          single('.cursor/rules/c.mdc', 'C.\n'),
        ]);
        const input = [
          skill('x2', skillMd(null)),
          single('.cursor/rules/b.mdc', 'A.\n'),
          single('.cursor/rules/c.mdc', 'C.\n'),
        ];
        await scan(handle, a, reverse ? input.reverse() : input);
        return await snapshot(handle);
      } finally {
        database.dispose();
      }
    };
    expect(await run(false)).toEqual(await run(true));
  });

  it('keeps a candidate out when its version lacks its primary file (rows scans never write)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [single('.cursor/rules/a.mdc', 'A.\n'), skill('k', skillMd(null))]);
    handle.sqlite.exec("update artifact_versions set files = '[]' where format = 'cursor-rule'");
    expect(
      await scan(handle, a, [single('.cursor/rules/b.mdc', 'A.\n'), skill('k', skillMd(null))]),
    ).toMatchObject({ movedOccurrences: 0, ambiguousMoves: 0, createdArtifacts: 1 });
  });

  it('never moves a discovered artifact whose files lack its primary file', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [single('.cursor/rules/a.mdc', 'A.\n'), skill('k', skillMd(null))]);
    const renamed = single('.cursor/rules/b.mdc', 'A.\n');
    expect(
      await scan(handle, a, [
        { ...renamed, files: [{ path: 'other.mdc', content: 'A.\n' }] },
        skill('k', skillMd(null)),
      ]),
    ).toMatchObject({ movedOccurrences: 0, ambiguousMoves: 0, createdArtifacts: 1 });
  });

  it('rolls back the whole scan when a move fails and names the path (§13)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('x', skillMd(null)), skill('keep', skillMd(null, 'K.'))]);
    const before = await snapshot(handle);
    handle.sqlite.exec(
      "create trigger fail_move before update on artifact_occurrences when new.path = 'x2' begin select raise(abort, 'move refused'); end",
    );
    const failure = await scan(handle, a, [
      skill('x2', skillMd(null)),
      skill('keep', skillMd(null, 'Edited.')),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({ path: 'x2' });
    expect(await snapshot(handle)).toEqual(before);
  });

  it(
    'reads unseen versions only when both sides exist, one statement per IDENTITY_LOOKUP_BATCH_SIZE (NFR-126-03)',
    async () => {
      const handle = getHandle();
      const a = await local(handle, 'a');
      const count = IDENTITY_LOOKUP_BATCH_SIZE * 2 + 1;
      const skills = (dir: string) =>
        Array.from({ length: count }, (_, i) =>
          skill(`${dir}/s${String(i).padStart(4, '0')}`, skillMd(null, `Body ${i}.`)),
        );
      const isUnseenRead = (query: string) =>
        query.startsWith('select "id", "format", "content_hash", "primary_file", case when') &&
        query.includes('"artifact_versions"."id" in');
      await scan(handle, a, skills('old'));

      const prepare = vi.spyOn(handle.sqlite, 'prepare');
      // A rescan without deletions reads no unseen version.
      await scan(handle, a, skills('old'));
      expect(prepare.mock.calls.map(([query]) => query).filter(isUnseenRead)).toEqual([]);
      prepare.mockClear();
      const summary = await scan(handle, a, skills('new'));
      const statements = prepare.mock.calls.map(([query]) => query);
      prepare.mockRestore();
      // The seam fired: every path moved.
      expect(summary).toMatchObject({ movedOccurrences: count, createdArtifacts: 0 });
      expect(statements.filter(isUnseenRead)).toHaveLength(3);
    },
    MANY_ARTIFACTS_TIMEOUT_MS,
  );

  it(
    'moves thousands of skills in linear time (NFR-126-03)',
    async () => {
      const built: { dispose(): void }[] = [];
      try {
        const build = async (size: number) => {
          const database = await openTestDatabase();
          built.push(database);
          const { handle } = database;
          const a = await local(handle, 'a');
          const at = (dir: string) =>
            Array.from({ length: size }, (_, i) => skill(`${dir}/s${i}`, skillMd(null, `B${i}.`)));
          await scan(handle, a, at('one'));
          return { handle, a, there: at('two'), back: at('one'), flip: { next: 'there' } };
        };
        await expectLinearTime({
          build,
          // Move every skill to the other directory, alternating so each call moves them all.
          run: async (input) => {
            const next = input.flip.next === 'there' ? input.there : input.back;
            input.flip.next = input.flip.next === 'there' ? 'back' : 'there';
            await scan(input.handle, input.a, next);
          },
          // A rescan of the current paths through rule 1, known to be linear.
          baseline: (input) =>
            scan(input.handle, input.a, input.flip.next === 'there' ? input.back : input.there),
          size: 3_200,
        });
      } finally {
        for (const database of built) database.dispose();
      }
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});

describe('version lineage (SPEC-126 FR-126-19)', () => {
  it('records the version the writing occurrence held, on insert only', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, b, [skill('skills/review', skillMd('review'))]);
    await scan(handle, a, [skill('skills/review', skillMd('review', 'A edit.'))]); // v2
    await scan(handle, b, [skill('skills/review', skillMd('review', 'B edit.'))]); // v3
    await scan(handle, b, [skill('skills/review', skillMd('review', 'A edit.'))]); // v2 reused
    await scan(handle, b, [skill('skills/review', skillMd('review', 'B again.'))]); // v4
    await scan(handle, a, [skill('skills/review', skillMd('review'))]); // v1 reused (revert)
    await scan(handle, a, [skill('skills/review', skillMd('review', 'After revert.'))]); // v5
    const artifact = await onlyArtifact(handle);
    const versions = await versionsOf(handle, artifact.id);
    const id = (n: number) => versions.find((v) => v.version === n)?.id;
    expect(versions.map((v) => [v.version, v.parentVersionId])).toEqual([
      [1, null],
      [2, id(1)],
      [3, id(1)],
      [4, id(2)],
      [5, id(1)],
    ]);
  });

  it('records the parent of a bundled example version and never of a new artifact', async () => {
    const handle = getHandle();
    const first = await importArtifactVersion(handle, artifactInput('v1'));
    const second = await importArtifactVersion(handle, artifactInput('v2'));
    const versions = await versionsOf(handle, first.artifactId);
    expect(versions.map((v) => v.parentVersionId)).toEqual([null, first.versionId]);
    expect(second.version).toBe(2);
  });
});

describe('source fields follow the active occurrences (FR-126-07, FR-126-23, A9)', () => {
  const name = async (handle: DatabaseHandle) => {
    const artifact = await onlyArtifact(handle);
    return [artifact.name, artifact.description];
  };

  it('takes the name of the copy holding the highest version, in either scan order', async () => {
    const run = async (order: 'ab' | 'ba') => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        const b = await local(handle, 'b');
        await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        await scan(handle, b, [skill('skills/review', skillMd('review'))]);
        const edits = {
          [a]: [skill('skills/review', skillMd('review'))],
          [b]: [skill('skills/review', skillMd('review-b', 'B', 'From B'))],
        };
        for (const id of order === 'ab' ? [a, b] : [b, a]) await scan(handle, id, edits[id]!);
        return await name(handle);
      } finally {
        database.dispose();
      }
    };
    expect(await run('ab')).toEqual(['review-b', 'From B']);
    expect(await run('ba')).toEqual(['review-b', 'From B']);
  });

  it('lets the copy scanned last name the artifact when both copies are renamed (A9)', async () => {
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
        return (await name(handle))[0];
      } finally {
        database.dispose();
      }
    };
    expect(await run('ab')).toBe('beta');
    expect(await run('ba')).toBe('alpha');
  });

  it('follows a revert of a single occurrence', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('one'))]);
    await scan(handle, a, [skill('skills/review', skillMd('two'))]);
    expect(await name(handle)).toEqual(['two', 'Reviews code']);
    await scan(handle, a, [skill('skills/review', skillMd('one'))]);
    expect(await name(handle)).toEqual(['one', 'Reviews code']);
  });

  it('falls back to the remaining copy when the highest is deleted, in the same scan or another', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('x/review', skillMd('one')), skill('y/review', skillMd('one'))]);
    await scan(handle, a, [skill('x/review', skillMd('one')), skill('y/review', skillMd('two'))]);
    expect((await name(handle))[0]).toBe('two');
    // Same scan: y is gone, so x (v1) names the artifact again.
    await scan(handle, a, [skill('x/review', skillMd('one'))]);
    expect((await name(handle))[0]).toBe('one');

    // Another scan: B holds the highest version, then loses it.
    await scan(handle, b, [skill('y/review', skillMd('one'))]);
    await scan(handle, b, [skill('y/review', skillMd('three'))]);
    expect((await name(handle))[0]).toBe('three');
    await scan(handle, b, [single('AGENTS.md', '# B')]);
    const artifacts = await listArtifacts(handle.db);
    expect(artifacts.find((row) => row.occurrenceCount === 1 && row.type === 'skill')?.name).toBe(
      'one',
    );
  });

  it('names a skill without a frontmatter name after the chosen occurrence directory', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, b, [skill('tools/check', skillMd('review'))]);
    await scan(handle, b, [skill('tools/check', skillMd(null))]);
    expect((await name(handle))[0]).toBe('check');
    // The root skill reads SKILL.md at the root and is named "skill". Since Phase 3 the same
    // content moving to the root is a move (rule 2), so the one artifact follows it.
    await scan(handle, b, [skill('', skillMd(null))]);
    expect((await listArtifacts(handle.db)).map((row) => row.name)).toEqual(['skill']);
  });

  it('keeps the name when no active occurrence is left, or the chosen version has no primary file', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')]);
    const artifact = (await listArtifacts(handle.db)).find((row) => row.type === 'skill');
    await handle.db
      .update(schema.artifacts)
      .set({ name: 'renamed by hand' })
      .where(eq(schema.artifacts.id, artifact?.id ?? ''));
    await scan(handle, a, [single('AGENTS.md', '# A')]);
    expect((await getArtifactDetail(handle.db, artifact?.id ?? ''))?.artifact.name).toBe(
      'renamed by hand',
    );
    // A damaged row (no primary file) is kept rather than guessed.
    handle.sqlite
      .prepare("update artifact_versions set files = '[]' where artifact_id = ?")
      .run(artifact?.id ?? '');
    await scan(handle, a, [skill('skills/review', skillMd('review')), single('AGENTS.md', '# A')]);
    expect((await getArtifactDetail(handle.db, artifact?.id ?? ''))?.artifact.name).toBe(
      'renamed by hand',
    );
  });

  it('refreshes names when a repository is removed, before or after a rescan of the other copy (FR-126-23)', async () => {
    const run = async (rescan: 'before' | 'after') => {
      const database = await openTestDatabase();
      try {
        const { handle } = database;
        const a = await local(handle, 'a');
        const b = await local(handle, 'b');
        await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        await scan(handle, b, [skill('skills/review', skillMd('review'))]);
        await scan(handle, b, [skill('skills/review', skillMd('review-b', 'B', 'From B'))]);
        expect(await name(handle)).toEqual(['review-b', 'From B']);
        if (rescan === 'before') await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        expect(await removeRepository(handle, b)).toMatchObject({
          status: 'removed',
          artifactsLeftMissing: 0,
        });
        if (rescan === 'after') await scan(handle, a, [skill('skills/review', skillMd('review'))]);
        return await name(handle);
      } finally {
        database.dispose();
      }
    };
    expect(await run('before')).toEqual(['review', 'Reviews code']);
    expect(await run('after')).toEqual(['review', 'Reviews code']);
  });
});

describe('occurrence versions and the job result (FR-126-09, UD-3)', () => {
  it('shows the version each occurrence holds', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    await scan(handle, b, [skill('skills/review', skillMd('review'))]);
    await scan(handle, a, [skill('skills/review', skillMd('review', 'Edited.'))]);
    const artifact = await onlyArtifact(handle);
    const detail = await getArtifactDetail(handle.db, artifact.id);
    expect(detail?.occurrences.map((o) => [o.repository.name, o.version])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('parses the new counts in a stored job result', () => {
    const result = {
      ok: true,
      scannedFiles: 3,
      discovered: 3,
      createdArtifacts: 1,
      createdVersions: 1,
      linkedOccurrences: 2,
      ambiguousLinks: 1,
      movedOccurrences: 3,
      ambiguousMoves: 4,
      warningCount: 0,
      errorCount: 0,
      errors: [],
      durationMs: 5,
    };
    expect(repositoryScanResultSchema.parse(result)).toMatchObject({
      linkedOccurrences: 2,
      ambiguousLinks: 1,
      movedOccurrences: 3,
      ambiguousMoves: 4,
    });
    expect(repositoryScanResultSchema.safeParse({ ...result, ambiguousMoves: -1 }).success).toBe(
      false,
    );
    expect(repositoryScanResultSchema.safeParse({ ...result, linkedOccurrences: -1 }).success).toBe(
      false,
    );
  });
});

describe('possible duplicates (SPEC-126 FR-126-11 to FR-126-13, AC-2)', () => {
  const counts = async (handle: DatabaseHandle, filter: Parameters<typeof listArtifacts>[1] = {}) =>
    Object.fromEntries(
      (await listArtifacts(handle.db, filter)).map((row) => [row.slug, row.possibleDuplicates]),
    );
  const bySlug = async (handle: DatabaseHandle, slug: string) => {
    const row = await handle.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.slug, slug))
      .get();
    if (!row) throw new Error(`no artifact ${slug}`);
    return row;
  };
  const duplicatesOf = async (handle: DatabaseHandle, slug: string) =>
    (await getArtifactDetail(handle.db, (await bySlug(handle, slug)).id))?.possibleDuplicates;

  it('flags same-named skills with different content in two repositories and lists each other (AC-2)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review', 'Review A.'))]);
    await scan(handle, b, [skill('skills/review', skillMd('review', 'Review B.'))]);
    expect(await counts(handle)).toEqual({ review: 1, 'review-2': 1 });
    const review = await bySlug(handle, 'review');
    const review2 = await bySlug(handle, 'review-2');
    expect(await duplicatesOf(handle, 'review')).toEqual({
      items: [
        {
          id: review2.id,
          slug: 'review-2',
          name: 'review',
          activeOccurrences: 1,
          repositories: [{ id: b, name: 'b' }],
          sameLatestContent: false,
        },
      ],
      total: 1,
    });
    expect(await duplicatesOf(handle, 'review-2')).toMatchObject({
      items: [{ id: review.id, slug: 'review', repositories: [{ id: a, name: 'a' }] }],
      total: 1,
    });
  });

  it('decides by the format alone: skills named by their directory are flagged, instructions and other formats never (G14, A15)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [
      skill('skills/anon', skillMd(null, 'Anon A.')),
      single('.cursor/rules/style.mdc', '---\nglobs: "*.ts"\n---\nUse tabs.\n'),
      single('.claude/rules/style.md', 'Style.\n'),
      single('.github/instructions/api.instructions.md', '---\napplyTo: "api/**"\n---\nA\n'),
      single('AGENTS.md', '# A\n'),
      single('.gitlab/duo/chat-rules.md', '# Duo A\n'),
    ]);
    await scan(handle, b, [
      // Identical, so never linked (A2), and flagged as a possible duplicate (§14).
      skill('skills/anon', skillMd(null, 'Anon A.')),
      single('.cursor/rules/style.mdc', '---\nglobs: "*.ts"\n---\nUse spaces.\n'),
      single('.github/instructions/api.instructions.md', '---\napplyTo: "api/**"\n---\nB\n'),
      single('AGENTS.md', '# B\n'),
      single('.gitlab/duo/chat-rules.md', '# Duo B\n'),
    ]);
    const listed = await counts(handle);
    const flagged = Object.entries(listed).filter(([, n]) => n > 0);
    expect(flagged.map(([slug]) => slug).sort()).toEqual([
      'anon',
      'anon-2',
      'api',
      'api-2',
      'style-2',
      'style-3',
    ]);
    // The claude-rule `style` (first in path order) shares the cursor rules' name and type, not
    // their format.
    expect(listed.style).toBe(0);
    expect(await duplicatesOf(handle, 'style')).toEqual({ items: [], total: 0 });
    expect(await duplicatesOf(handle, 'anon')).toMatchObject({
      items: [{ slug: 'anon-2', sameLatestContent: true }],
    });
    const agents = (await listArtifacts(handle.db)).filter((row) => row.name === 'AGENTS.md');
    expect(agents.map((row) => row.possibleDuplicates)).toEqual([0, 0]);
    expect(await duplicatesOf(handle, agents[0]!.slug)).toEqual({ items: [], total: 0 });
  });

  it('counts duplicates the list filters out, and missing, hosted and bundled ones (A15, A16, G8, G13)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const c = await local(handle, 'c');
    const gh = await hosted(handle, 'gh');
    await importArtifactVersion(
      handle,
      artifactInput('Bundled review.', { slug: 'review', name: 'review' }),
    );
    await scan(handle, a, [skill('skills/review', skillMd('review', 'Shared.'))]);
    await scan(handle, gh, [skill('skills/review', skillMd('review', 'Shared.'))]);
    await scan(handle, c, [skill('skills/review', skillMd('review', 'C.'))]);
    // The copy in c disappears (marked removed): its artifact is missing.
    await scan(handle, c, [single('AGENTS.md', '# C\n')]);
    expect(await counts(handle, { repository: a })).toEqual({ 'review-2': 3 });
    expect(await counts(handle, { type: 'skill' })).toEqual({
      review: 3,
      'review-2': 3,
      'review-3': 3,
      'review-4': 3,
    });
    const listed = await duplicatesOf(handle, 'review-2');
    expect(listed?.total).toBe(3);
    expect(
      listed?.items.map((item) => [
        item.slug,
        item.repositories.map((r) => r.id),
        item.activeOccurrences,
        item.sameLatestContent,
      ]),
    ).toEqual([
      ['review', [expect.any(String)], 1, false],
      ['review-3', [gh], 1, true],
      ['review-4', [], 0, false],
    ]);
    // A missing artifact shows its own card too (G13).
    expect((await duplicatesOf(handle, 'review-4'))?.total).toBe(3);
  });

  it('lists at most MAX_LISTED_DUPLICATES, oldest first then by id, with the total (FR-126-13)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    const b = await local(handle, 'b');
    await scan(handle, a, [skill('skills/review', skillMd('review', 'First.'))]);
    await scan(
      handle,
      b,
      Array.from({ length: MAX_LISTED_DUPLICATES + 4 }, (_, i) =>
        skill(`skills/r${String(i).padStart(2, '0')}`, skillMd('review', `Copy ${i}.`)),
      ),
    );
    const others = (await handle.db.select().from(schema.artifacts))
      .filter((row) => row.slug !== 'review')
      .map((row) => row.slug);
    const listed = await duplicatesOf(handle, 'review');
    expect(listed?.total).toBe(MAX_LISTED_DUPLICATES + 4);
    expect(listed?.items).toHaveLength(MAX_LISTED_DUPLICATES);
    const ids = new Map(
      (await handle.db.select().from(schema.artifacts)).map((row) => [row.slug, row.id]),
    );
    // Same `created_at` (one scan): ordered by id.
    const expected = [...others]
      .sort((x, y) => (ids.get(x)! < ids.get(y)! ? -1 : 1))
      .slice(0, MAX_LISTED_DUPLICATES);
    expect(listed?.items.map((item) => item.slug)).toEqual(expected);
    // The older artifact comes first on a younger one's card.
    expect((await duplicatesOf(handle, expected[0]!))?.items[0]?.slug).toBe('review');
    expect((await counts(handle)).review).toBe(MAX_LISTED_DUPLICATES + 4);
  });

  it('has no duplicates for an artifact without a version', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    handle.sqlite
      .prepare(
        `insert into artifacts (id, slug, name, type, created_at, updated_at)
         values ('art_bare', 'bare', 'review', 'skill', 't', 't')`,
      )
      .run();
    expect(await counts(handle)).toEqual({ review: 0, bare: 0 });
    expect(await duplicatesOf(handle, 'bare')).toEqual({ items: [], total: 0 });
  });

  it('reads the groups in one grouped statement on artifacts_type_name_idx (NFR-126-02)', async () => {
    const handle = getHandle();
    const a = await local(handle, 'a');
    await scan(handle, a, [skill('skills/review', skillMd('review'))]);
    const prepare = vi.spyOn(handle.sqlite, 'prepare');
    await listArtifacts(handle.db);
    const statements = prepare.mock.calls.map(([query]) => query);
    prepare.mockRestore();
    const grouped = statements.filter((query) => query.includes('group by'));
    expect(grouped).toHaveLength(1);
    const plan = handle.sqlite
      .prepare(`explain query plan ${grouped[0]!}`)
      .all(...POSSIBLE_DUPLICATE_FORMATS, 1)
      .map((row) => String((row as { detail: string }).detail));
    expect(plan.join('\n')).toContain('artifacts_type_name_idx');
  });

  it(
    'counts duplicates of 10,016 artifacts in linear time (§21 Phase 2)',
    async () => {
      const built: { dispose(): void }[] = [];
      /** `size` skills in pairs of the same name, written with raw SQL so building stays fast. */
      const build = async (size: number) => {
        const database = await openTestDatabase();
        built.push(database);
        const { sqlite } = database.handle;
        const artifact = sqlite.prepare(
          `insert into artifacts (id, slug, name, type, created_at, updated_at)
           values (?, ?, ?, 'skill', 't', 't')`,
        );
        const version = sqlite.prepare(
          `insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
           values (?, ?, 1, ?, 'skill-md', 'SKILL.md', '[]', '{}', 't')`,
        );
        sqlite.exec('BEGIN');
        for (let i = 0; i < size; i += 1) {
          artifact.run(`art_${i}`, `s${i}`, `skill-${Math.floor(i / 2)}`);
          version.run(`ver_${i}`, `art_${i}`, `h${i}`);
        }
        sqlite.exec('COMMIT');
        return database.handle;
      };
      try {
        const small = await build(4);
        expect((await listArtifacts(small.db)).map((row) => row.possibleDuplicates)).toEqual([
          1, 1, 1, 1,
        ]);
        await expectLinearTime({
          build,
          run: (database) => listArtifacts(database.db),
          // Reading every artifact and version row once is linear in the same data.
          baseline: async (database) => {
            await database.db.select().from(schema.artifacts);
            await database.db.select().from(schema.artifactVersions);
          },
          size: 10_016,
        });
      } finally {
        for (const database of built) database.dispose();
      }
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});
