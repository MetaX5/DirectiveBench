import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { DEMO_SUITE, e2eTmpRoot, withDatabase } from './support';

// SPEC-126 Phase 1 (§15, §21 step 5, §11.3 F17): a skill copied unchanged into a second local
// repository is one artifact with two occurrences (AC-1); its metadata is kept (AC-5); after the
// copies diverge each occurrence shows its version, an older one is marked, and results by
// version compare along the edit history (AC-9); removing the second repository leaves no
// artifact missing and the remaining copy names the artifact again (AC-7, FR-126-23).

/** The runner polls every second; leave room for a slow CI host. */
const RUNNER_TIMEOUT = 30_000;
const FIRST = 'identity-e2e-a';
const SECOND = 'identity-e2e-b';
const SKILL = 'identity-e2e-review';
const SKILL_PATH = `.agents/skills/${SKILL}/SKILL.md`;
// Each fixture gets its own root, never a folder under one another spec registered (lesson
// 2026-11-13).
const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'identity-')));

function skill(description: string, body = 'Review the diff.'): string {
  return `---\nname: ${SKILL}\ndescription: ${description}\n---\n# Review\n\n${body}\n`;
}

function write(repository: string, relPath: string, content: string): void {
  const path = join(sources, repository, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function register(page: Page, repository: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByLabel('Path').fill(join(sources, repository));
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByTestId('registration-status')).toContainText(`Registered ${repository}`, {
    timeout: RUNNER_TIMEOUT,
  });
}

async function scan(page: Page, repository: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByRole('button', { name: `Scan ${repository}` }).click();
  await expect(page.getByTestId('scan-status')).toContainText(`Scanned ${repository}:`, {
    timeout: RUNNER_TIMEOUT,
  });
}

function artifactId(): Promise<string> {
  return withDatabase(
    (db) => (db.prepare('select id from artifacts where name = ?').get(SKILL) as { id: string }).id,
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectContrast(page: Page, label: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    const failures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
    expect(failures, `${label} ${theme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Seeded mock-agent runs, one per version, so the results tab shows the lineage (F17). */
const RUNS = ['run_e2e126_v1', 'run_e2e126_v2', 'run_e2e126_v3'];

function seedRuns(artifact: string): Promise<void> {
  return withDatabase((db) => {
    const suiteVersion = (
      db
        .prepare(
          `select sv.id from benchmark_suite_versions sv
             join benchmark_suites s on s.id = sv.suite_id where s.name = ? limit 1`,
        )
        .get(DEMO_SUITE) as { id: string }
    ).id;
    const insert = db.prepare(
      `insert into benchmark_runs
         (id, suite_version_id, artifact_version_id, agent_adapter_id, environment, status,
          verdict, comparability_key, summary, warnings, started_at, finished_at)
       select ?, ?, v.id, 'mock', '{}', 'completed', 'improved', ?, ?, '[]', ?, ?
         from artifact_versions v where v.artifact_id = ? and v.version = ?`,
    );
    // Newer than the demo run, which other specs find as the oldest run (lesson 2026-10-29).
    const start = Date.now();
    [0.9, 0.95, 0.6].forEach((score, index) => {
      const at = new Date(start + index * 1000).toISOString();
      insert.run(
        RUNS[index] as string,
        suiteVersion,
        'e'.repeat(64),
        JSON.stringify({
          candidate: { meanScore: score },
          baseline: { meanScore: 0 },
          delta: score,
          verdict: 'improved',
          candidateOutcome: 'passed',
          confidence: { level: 'low' },
          scoring: { minDelta: 0.05 },
        }),
        at,
        at,
        artifact,
        index + 1,
      );
    });
  });
}

test.describe.serial('exact copies and version lineage (SPEC-126 Phase 1)', () => {
  /** Jobs that existed before the fixture repositories were registered and scanned. */
  let jobsBefore = new Set<string>();

  test.beforeAll(async () => {
    jobsBefore = await withDatabase(
      (db) =>
        new Set((db.prepare('select id from jobs').all() as { id: string }[]).map((j) => j.id)),
    );
    write(FIRST, 'AGENTS.md', '# Identity fixture rules\n');
    write(FIRST, SKILL_PATH, skill('Identity fixture.'));
    write(SECOND, SKILL_PATH, skill('Identity fixture.'));
  });

  // Other spec files count artifacts and jobs (lesson 2026-11-10): leave the database as found.
  test.afterAll(async () => {
    await withDatabase((db) => {
      const remove = (sql: string, id: string) => db.prepare(sql).run(id);
      for (const id of RUNS) remove('delete from benchmark_runs where id = ?', id);
      const artifacts = db
        .prepare(
          `select distinct o.artifact_id as id from artifact_occurrences o
             join repositories r on r.id = o.repository_id where r.name in (?, ?)`,
        )
        .all(FIRST, SECOND) as { id: string }[];
      for (const name of [FIRST, SECOND]) remove('delete from repositories where name = ?', name);
      for (const { id } of artifacts) remove('delete from artifacts where id = ?', id);
      remove('delete from artifacts where name = ?', SKILL);
      for (const { id } of db.prepare('select id from jobs').all() as { id: string }[]) {
        if (!jobsBefore.has(id)) remove('delete from jobs where id = ?', id);
      }
    });
    rmSync(sources, { recursive: true, force: true });
  });

  test('an identical skill in a second repository matches the existing artifact (AC-1, AC-5)', async ({
    page,
  }) => {
    await register(page, FIRST);
    await scan(page, FIRST);
    // User metadata set before the copy is scanned must survive the link (AC-5).
    const id = await artifactId();
    await withDatabase((db) =>
      db.prepare(`update artifacts set tags = '["shared"]', notes = 'Kept.' where id = ?`).run(id),
    );
    await register(page, SECOND);
    await scan(page, SECOND);
    const status = page.getByTestId('scan-status');
    await expect(status).toHaveText(
      /^Scanned identity-e2e-b: \d+ files? in [\d.]+ (ms|s), 1 artifact found \(0 new, 1 matched an existing artifact, 0 new versions\), 0 errors\.$/,
    );
    await expect(status).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('scan-explanation')).toContainText(
      'A skill or rule identical to one already found in another local repository is added to that artifact instead of becoming a new one.',
    );
    await expectContrast(page, 'scan line');

    expect(await artifactId()).toBe(id);
    expect(
      await withDatabase((db) =>
        db.prepare('select tags, notes from artifacts where id = ?').get(id),
      ),
    ).toEqual({ tags: '["shared"]', notes: 'Kept.' });

    // The list: one row, both repositories, two occurrences (UD-2).
    await page.goto(`/artifacts?q=${SKILL}`);
    const rows = page.getByRole('row').filter({ hasText: SKILL });
    await expect(rows).toHaveCount(1);
    const cells = rows.getByRole('cell');
    await expect(cells.nth(4)).toHaveText(`${FIRST} +1`);
    await expect(cells.nth(5)).toHaveText('2');

    // The page: two occurrences holding v1, neither marked older.
    await page.goto(`/artifacts/${id}`);
    const table = page.getByRole('region', { name: 'Occurrences' });
    await expect(table.getByTestId('occurrence-row')).toHaveCount(2);
    await expect(table.getByTestId('occurrence-version')).toHaveText(['v1', 'v1']);
    await expect(table.getByTestId('older-version')).toHaveCount(0);
  });

  test('diverged copies show each version, mark the older one and compare along the edit history (AC-5, AC-9)', async ({
    page,
  }) => {
    const id = await artifactId();
    // A edits first (v2 from v1), then B edits its own copy (v3, also from v1).
    write(FIRST, SKILL_PATH, skill('Identity fixture.', 'Review the diff in A.'));
    await scan(page, FIRST);
    await expect(page.getByTestId('scan-status')).toContainText('(0 new, 1 new version)');
    write(SECOND, SKILL_PATH, skill('Edited in client B.', 'Review the diff in B.'));
    await scan(page, SECOND);
    await expect(page.getByTestId('scan-status')).toContainText('(0 new, 1 new version)');

    await page.goto(`/artifacts/${id}`);
    // The copy holding the latest version names the artifact (FR-126-07).
    await expect(page.getByRole('main')).toContainText('Edited in client B.');
    const rows = page.getByRole('region', { name: 'Occurrences' }).getByTestId('occurrence-row');
    const first = rows.filter({ hasText: FIRST });
    const second = rows.filter({ hasText: SECOND });
    await expect(first.getByTestId('occurrence-version')).toHaveText('v2');
    await expect(first.getByTestId('older-version')).toHaveText('older version');
    await expect(second.getByTestId('occurrence-version')).toHaveText('v3');
    await expect(second.getByTestId('older-version')).toHaveCount(0);
    const link = page.getByRole('link', { name: `v2 of ${SKILL}` });
    await expect(link).toHaveAttribute('href', `/artifacts/${id}?tab=content&version=2`);
    await expectContrast(page, 'occurrences');
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    // Keyboard: the version link is reachable and opens that version's content.
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/artifacts/${id}\\?tab=content&version=2$`));

    // Results by version: v3 (B's edit of v1) is compared with v1, never with A's parallel v2.
    await seedRuns(id);
    await page.goto(`/artifacts/${id}?tab=evaluations`);
    await expect(page.getByRole('main')).toContainText(
      'A version regression compares the latest run of a version with the latest run of the nearest tested version before it in its edit history, in the same group.',
    );
    const v3 = page.getByRole('region', { name: 'Version 3' });
    await expect(v3.getByTestId('edited-from')).toHaveText('edited from v1');
    await expect(v3.getByTestId('version-regression')).toHaveText(
      'Version regression vs v1 (-30 pts)',
    );
    await expect(
      v3.getByText('Version regression (mock agent, not an AI evaluation)'),
    ).toBeVisible();
    const v2 = page.getByRole('region', { name: 'Version 2' });
    await expect(v2.getByTestId('edited-from')).toHaveCount(0);
    await expect(v2.getByTestId('version-comparison')).toHaveText('No regression vs v1 (+5 pts)');
    await expectContrast(page, 'results by version');
  });

  test('removing the second repository leaves no artifact missing; the first copy names it again (AC-7)', async ({
    page,
  }) => {
    const id = await artifactId();
    const repository = await withDatabase(
      (db) =>
        (db.prepare('select id from repositories where name = ?').get(SECOND) as { id: string }).id,
    );
    await page.goto(`/repositories?remove=${repository}#remove-panel`);
    const panel = page.getByTestId('remove-panel');
    await expect(panel.getByRole('listitem')).toHaveText([
      'Its 1 occurrence is deleted from DirectiveBench.',
      'Every artifact found here is also found in another repository, or is already missing.',
      `Nothing in ${join(sources, SECOND)} is changed.`,
      'Registering it again later creates new artifacts. A skill or rule whose exact content is still recorded in another local repository is matched to its existing artifact instead.',
    ]);
    await expectContrast(page, 'removal panel');
    await page.getByRole('button', { name: 'Remove repository' }).click();
    await expect(page.getByTestId('remove-result')).toHaveText(
      'Repository removed: 1 occurrence deleted. No artifact became missing.',
    );

    await page.goto(`/artifacts/${id}`);
    await expect(page.getByTestId('missing-note')).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('Identity fixture.');
    await expect(page.getByRole('main')).not.toContainText('Edited in client B.');
    const rows = page.getByRole('region', { name: 'Occurrences' }).getByTestId('occurrence-row');
    await expect(rows).toHaveCount(1);
    // A holds v2 while the latest is B's v3, which stays the latest version (A10).
    await expect(rows.getByTestId('older-version')).toHaveText('older version');
  });
});

// SPEC-126 Phase 2 (§15, §21 Phase 2 step 3, §11.4 G17): two different skills with the same name
// in two local repositories stay two artifacts with suffixed slugs, and the list and both artifact
// pages mark them as possible duplicates of each other (AC-2). A seeded legacy copy with the same
// content and no occurrence left shows "Same latest content", the "Missing" Badge and the note.

const DUP_A = 'identity-e2e-dup-a';
const DUP_B = 'identity-e2e-dup-b';
const DUP = 'identity-e2e-dup';
const DUP_PATH = `.claude/skills/${DUP}/SKILL.md`;
const LEGACY = { id: 'art_e2e126legacy', slug: `${DUP}-legacy`, version: 'artv_e2e126legacy' };
// Its own root (lesson 2026-11-13): never a folder under another spec's registered repository.
const dupSources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'identity-dup-')));

function dupSkill(body: string): string {
  return `---\nname: ${DUP}\ndescription: Possible duplicate fixture.\n---\n# Review\n\n${body}\n`;
}

async function registerAt(page: Page, root: string, repository: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByLabel('Path').fill(join(root, repository));
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByTestId('registration-status')).toContainText(`Registered ${repository}`, {
    timeout: RUNNER_TIMEOUT,
  });
}

function dupIds(): Promise<Record<string, string>> {
  return withDatabase((db) =>
    Object.fromEntries(
      (
        db.prepare('select slug, id from artifacts where name = ?').all(DUP) as {
          slug: string;
          id: string;
        }[]
      ).map((row) => [row.slug, row.id]),
    ),
  );
}

test.describe.serial('possible duplicates (SPEC-126 Phase 2)', () => {
  let jobsBefore = new Set<string>();

  test.beforeAll(async () => {
    jobsBefore = await withDatabase(
      (db) =>
        new Set((db.prepare('select id from jobs').all() as { id: string }[]).map((j) => j.id)),
    );
    for (const [repository, body] of [
      [DUP_A, 'Review the diff for client A.'],
      [DUP_B, 'Review the diff for client B.'],
    ] as const) {
      const path = join(dupSources, repository, DUP_PATH);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, dupSkill(body));
    }
  });

  // Leave the shared database as found (lesson 2026-11-10).
  test.afterAll(async () => {
    await withDatabase((db) => {
      const remove = (sql: string, id: string) => db.prepare(sql).run(id);
      for (const name of [DUP_A, DUP_B]) remove('delete from repositories where name = ?', name);
      remove('delete from artifacts where name = ?', DUP);
      for (const { id } of db.prepare('select id from jobs').all() as { id: string }[]) {
        if (!jobsBefore.has(id)) remove('delete from jobs where id = ?', id);
      }
    });
    rmSync(dupSources, { recursive: true, force: true });
  });

  test('same-named skills with different content stay apart and point at each other (AC-2)', async ({
    page,
  }) => {
    for (const repository of [DUP_A, DUP_B]) {
      await registerAt(page, dupSources, repository);
      await scan(page, repository);
    }
    await expect(page.getByTestId('scan-status')).toContainText('(1 new, 1 new version)');
    const ids = await dupIds();
    // Not merged: two artifacts whose slugs differ by a suffix.
    expect(Object.keys(ids).sort()).toEqual([DUP, `${DUP}-2`]);

    await page.goto(`/artifacts?q=${DUP}`);
    const rows = page.getByRole('row').filter({ hasText: DUP });
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const badge = row.getByTestId('possible-duplicate');
      await expect(badge).toHaveText('Possible duplicate');
      await expect(badge).not.toHaveAttribute('title');
      expect(await badge.evaluate((element) => element.getClientRects().length)).toBe(1);
    }
    await expectContrast(page, 'list with possible duplicates');

    for (const [own, other, repository] of [
      [DUP, `${DUP}-2`, DUP_B],
      [`${DUP}-2`, DUP, DUP_A],
    ] as const) {
      await page.goto(`/artifacts/${ids[own]}`);
      await expect(page.getByTestId('possible-duplicate')).toHaveText('Possible duplicate');
      const card = page.getByTestId('possible-duplicates');
      await expect(card.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible();
      await expect(card).toContainText(
        'Other artifacts with the same name and format. Each one keeps its own versions and results.',
      );
      const table = card.getByRole('region', { name: 'Possible duplicates' });
      const row = table.getByTestId('duplicate-row');
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('link', { name: other, exact: true })).toHaveAttribute(
        'href',
        `/artifacts/${ids[other]}`,
      );
      await expect(row.getByRole('cell').nth(1)).toHaveText(repository);
      await expect(row.getByRole('cell').nth(2)).toHaveText('Different content');
      await expect(card.getByTestId('duplicates-note')).toHaveCount(0);
      await expect(card.getByTestId('duplicates-more')).toHaveCount(0);
    }
    // The header Badge shows on every tab (G3); the card only on Overview.
    await page.goto(`/artifacts/${ids[DUP]}?tab=versions`);
    await expect(page.getByTestId('possible-duplicate')).toBeVisible();
    await expect(page.getByTestId('possible-duplicates')).toHaveCount(0);
  });

  test('a same-content copy shows the note and a missing one the Missing Badge; keyboard, 320px, contrast', async ({
    page,
  }) => {
    const ids = await dupIds();
    // A legacy copy of A's content with no occurrence left (recorded before matching, A6, G13).
    await withDatabase((db) => {
      const now = new Date().toISOString();
      db.prepare(
        `insert into artifacts (id, slug, name, type, created_at, updated_at)
         values (?, ?, ?, 'skill', ?, ?)`,
      ).run(LEGACY.id, LEGACY.slug, DUP, now, now);
      db.prepare(
        `insert into artifact_versions
           (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
         select ?, ?, 1, content_hash, format, primary_file, files, parsed_metadata, ?
           from artifact_versions where artifact_id = ? order by version desc limit 1`,
      ).run(LEGACY.version, LEGACY.id, now, ids[DUP]!);
    });
    await page.goto(`/artifacts/${ids[DUP]}`);
    const card = page.getByTestId('possible-duplicates');
    const rows = card.getByTestId('duplicate-row');
    await expect(rows).toHaveCount(2);
    const legacy = rows.filter({ hasText: LEGACY.slug });
    await expect(legacy.getByRole('cell').nth(1)).toHaveText('Missing');
    await expect(legacy.getByRole('cell').nth(2)).toHaveText('Same latest content');
    await expect(card.getByTestId('duplicates-note')).toHaveText(
      'Same latest content does not make them one artifact. An identical copy is matched only when it is first found at a path in a local repository, and never for a copy in a GitHub repository, the bundled example or a skill without a name in its frontmatter. Copies recorded before DirectiveBench started matching identical copies also stay separate.',
    );
    await expectContrast(page, 'possible duplicates card');

    // B's latest content differs from both: no note.
    await page.goto(`/artifacts/${ids[`${DUP}-2`]}`);
    await expect(page.getByTestId('duplicate-row')).toHaveCount(2);
    await expect(page.getByTestId('duplicates-note')).toHaveCount(0);

    // The missing legacy artifact shows its own card (G13).
    await page.goto(`/artifacts/${LEGACY.id}`);
    await expect(page.getByTestId('duplicate-row')).toHaveCount(2);
    await expect(page.getByTestId('duplicates-note')).toBeVisible();

    // 320px: no document scroll on either page.
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of [`/artifacts/${ids[DUP]}`, `/artifacts?q=${DUP}`]) {
      await page.goto(path);
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Keyboard: the slug link is reachable and opens that artifact.
    await page.goto(`/artifacts/${ids[DUP]}`);
    const link = page.getByRole('link', { name: `${DUP}-2`, exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/artifacts/${ids[`${DUP}-2`]}$`));
  });
});

// SPEC-126 Phase 3 (§11.5 H12): between two scans of one repository, a renamed rule and a moved
// skill without a frontmatter name (neither explainable by rule 3) keep their artifact and
// occurrence (AC-3); two identical skills moved at once are not moved.
const MOVES = 'identity-e2e-moves';
const RULE_FROM = '.cursor/rules/identity-e2e-no-default-export.mdc';
const RULE_TO = '.cursor/rules/identity-e2e-no-default-exports.mdc';
const MOVER_FROM = '.claude/skills/identity-e2e-mover';
const MOVER_TO = '.agents/skills/identity-e2e-mover-moved';
const TWINS = ['identity-e2e-twin-x', 'identity-e2e-twin-y'];
// Its own root (lesson 2026-11-13).
const movesSources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'identity-moves-')));

function moveInFixture(from: string, to: string): void {
  const target = join(movesSources, MOVES, to);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(movesSources, MOVES, from), target);
}

function occurrenceAt(path: string): Promise<{ id: string; artifactId: string; status: string }> {
  return withDatabase(
    (db) =>
      db
        .prepare(
          `select o.id, o.artifact_id as artifactId, o.status from artifact_occurrences o
             join repositories r on r.id = o.repository_id where r.name = ? and o.path = ?`,
        )
        .get(MOVES, path) as { id: string; artifactId: string; status: string },
  );
}

test.describe.serial('moves keep identity (SPEC-126 Phase 3)', () => {
  let jobsBefore = new Set<string>();
  let artifactsBefore = new Set<string>();

  test.beforeAll(async () => {
    [jobsBefore, artifactsBefore] = await withDatabase((db) => [
      new Set((db.prepare('select id from jobs').all() as { id: string }[]).map((j) => j.id)),
      new Set((db.prepare('select id from artifacts').all() as { id: string }[]).map((a) => a.id)),
    ]);
    const files: Record<string, string> = {
      'AGENTS.md': '# Moves fixture\n',
      [RULE_FROM]: '---\ndescription: No default exports\nglobs: "*.ts"\n---\nUse named exports.\n',
      [`${MOVER_FROM}/SKILL.md`]: '---\ndescription: Move fixture.\n---\n# Mover\n',
    };
    for (const twin of TWINS)
      files[`pair/${twin}/SKILL.md`] = '---\ndescription: Twin.\n---\n# Twin\n';
    for (const [relPath, content] of Object.entries(files)) {
      const path = join(movesSources, MOVES, relPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  });

  // Leave the shared database as found (lesson 2026-11-10).
  test.afterAll(async () => {
    await withDatabase((db) => {
      const remove = (sql: string, id: string) => db.prepare(sql).run(id);
      remove('delete from repositories where name = ?', MOVES);
      for (const { id } of db.prepare('select id from artifacts').all() as { id: string }[]) {
        if (!artifactsBefore.has(id)) remove('delete from artifacts where id = ?', id);
      }
      for (const { id } of db.prepare('select id from jobs').all() as { id: string }[]) {
        if (!jobsBefore.has(id)) remove('delete from jobs where id = ?', id);
      }
    });
    rmSync(movesSources, { recursive: true, force: true });
  });

  test('a renamed rule and a moved skill without a name keep their artifact and occurrence (AC-3)', async ({
    page,
  }) => {
    await registerAt(page, movesSources, MOVES);
    await scan(page, MOVES);
    const rule = await occurrenceAt(RULE_FROM);
    const mover = await occurrenceAt(MOVER_FROM);

    moveInFixture(RULE_FROM, RULE_TO);
    moveInFixture(MOVER_FROM, MOVER_TO);
    await scan(page, MOVES);
    const status = page.getByTestId('scan-status');
    await expect(status).toHaveText(
      /^Scanned identity-e2e-moves: \d+ files? in [\d.]+ (ms|s), 5 artifacts found \(0 new, 2 moved, 1 new version\), 0 errors\.$/,
    );
    await expect(status).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('scan-explanation')).toContainText(
      'A skill, rule or instruction moved or renamed inside the repository between two scans keeps its artifact and history when its content is unchanged and nothing else added or removed in that scan has the same content. A renamed rule file gets a new version, because a rule is named after its file.',
    );
    await expectContrast(page, 'scan line with moves');

    expect(await occurrenceAt(RULE_TO)).toEqual({ ...rule, status: 'active' });
    expect(await occurrenceAt(MOVER_TO)).toEqual({ ...mover, status: 'active' });

    // The skill: same URL, one row with the new path, same version, no missing row (H5).
    await page.goto(`/artifacts/${mover.artifactId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('identity-e2e-mover-moved');
    let table = page.getByRole('region', { name: 'Occurrences' });
    await expect(table.getByTestId('occurrence-row')).toHaveCount(1);
    await expect(table.getByTestId('occurrence-row')).toContainText(MOVER_TO);
    await expect(table.getByTestId('occurrence-row')).toContainText('active');
    await expect(table.getByTestId('occurrence-version')).toHaveText('v1');

    // The rule: same URL, the next version (A13), and the Version history says why (H6).
    await page.goto(`/artifacts/${rule.artifactId}`);
    table = page.getByRole('region', { name: 'Occurrences' });
    await expect(table.getByTestId('occurrence-row')).toHaveCount(1);
    await expect(table.getByTestId('occurrence-row')).toContainText(RULE_TO);
    await expect(table.getByTestId('occurrence-version')).toHaveText('v2');
    await expect(table.getByTestId('older-version')).toHaveCount(0);
    await page.goto(`/artifacts/${rule.artifactId}?tab=versions`);
    await expect(
      page.getByText(
        'Versions are immutable; a new version is created only when the content or a file name changes.',
      ),
    ).toBeVisible();
  });

  test('two identical skills moved at once are not moved; 320px and contrast', async ({ page }) => {
    for (const twin of TWINS) moveInFixture(`pair/${twin}`, `moved/${twin}`);
    await scan(page, MOVES);
    const status = page.getByTestId('scan-status');
    await expect(status).toContainText(
      '(2 new, 2 new versions), 0 errors. 2 possible moves were not applied because several files matched. 2 no longer found (marked missing).',
    );
    await expect(status).toHaveAttribute('data-state', 'done');
    for (const twin of TWINS) expect((await occurrenceAt(`pair/${twin}`)).status).toBe('removed');
    await expectContrast(page, 'scan line with ambiguous moves');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload();
    await expect(status).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
