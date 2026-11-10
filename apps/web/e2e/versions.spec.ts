import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { DEMO_SUITE, e2eTmpRoot, withDatabase } from './support';

/**
 * Issue #19 (E02-S01, SPEC-103, SPEC-013 M1 AC2, SPEC-001 principle 15): a rescan through the UI
 * versions only changed content, the Versions tab shows each version's number, hash and date,
 * and what the user assigned to the artifact survives the rescan.
 */

/** The runner polls every second; leave room for a slow CI host. */
const RUNNER_TIMEOUT = 30_000;

const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'versions-')));
const repo = join(sources, 'versions-team');
const skillDir = '.agents/skills/e2e-versioned';
const checklist = join(repo, skillDir, 'references', 'checklist.md');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test.beforeAll(() => {
  write(
    join(repo, skillDir, 'SKILL.md'),
    '---\nname: e2e-versioned\ndescription: Changes between scans.\n---\n# Versioned\n',
  );
  write(checklist, '# Checklist\n');
  write(join(repo, 'AGENTS.md'), '# Versions team rules\n');
});

test.afterAll(() => rmSync(sources, { recursive: true, force: true }));

/** The same rendering as `formatDate` in `apps/web/lib/utils.ts`. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

interface StoredVersion {
  version: number;
  contentHash: string;
  createdAt: string;
}

function storedVersions(artifactId: string): Promise<StoredVersion[]> {
  return withDatabase(
    (db) =>
      db
        .prepare(
          `select version, content_hash as contentHash, created_at as createdAt
             from artifact_versions where artifact_id = ? order by version desc`,
        )
        .all(artifactId) as unknown as StoredVersion[],
  );
}

async function scan(page: Page, expected: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Scan versions-team' }).click();
  await expect(page.getByTestId('scan-status')).toContainText(expected, {
    timeout: RUNNER_TIMEOUT,
  });
}

async function expectVersionHistory(page: Page, artifactId: string): Promise<StoredVersion[]> {
  const versions = await storedVersions(artifactId);
  await page.goto(`/artifacts/${artifactId}?tab=versions`);
  const rows = page.getByTestId('version-row');
  await expect(rows).toHaveCount(versions.length);
  for (const [index, v] of versions.entries()) {
    const row = rows.nth(index);
    await expect(row.getByRole('link', { name: `v${v.version}`, exact: true })).toBeVisible();
    await expect(row.getByTestId('version-hash')).toHaveText(`${v.contentHash.slice(0, 16)}…`);
    // The full hash is one hover away, with what it is (SPEC-103 §11).
    await expect(row.getByTestId('version-hash')).toHaveAttribute(
      'title',
      `SHA-256 over the sorted file manifest: ${v.contentHash}`,
    );
    await expect(row.getByRole('cell').nth(2)).toHaveText('2');
    // First seen in this scan's repository and path; a working-tree scan has no commit (§11).
    await expect(row.getByTestId('version-first-seen')).toHaveText(`versions-team:${skillDir}`);
    await expect(row.getByRole('cell').nth(4)).toHaveText(formatDate(v.createdAt));
  }
  // Only the highest version is marked latest (SPEC-103 §11).
  await expect(page.getByTestId('latest-version')).toHaveCount(1);
  await expect(rows.first().getByTestId('latest-version')).toHaveText('latest');
  return versions;
}

test('a rescan versions only changed content, shown with number, hash and date, and keeps user metadata', async ({
  page,
}) => {
  await page.goto('/repositories');
  await page.getByLabel('Path').fill(repo);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByTestId('registration-status')).toHaveText(
    `Registered versions-team (Local directory, ${repo}).`,
    { timeout: RUNNER_TIMEOUT },
  );
  await scan(page, '2 artifacts found (2 new, 2 new versions)');

  const artifactId = await withDatabase((db) => {
    const row = db.prepare(`select id from artifacts where name = 'e2e-versioned'`).get() as
      { id: string } | undefined;
    if (!row) throw new Error('The scanned skill is missing');
    // Setup only: no UI assigns categories, tags or benchmarks to a scanned artifact yet.
    const now = new Date().toISOString();
    db.prepare(
      `insert into artifact_categories (artifact_id, category_id, created_at)
         select ?, id, ? from categories where slug = 'security'`,
    ).run(row.id, now);
    db.prepare(
      `insert into artifact_benchmark_assignments (artifact_id, suite_id, created_at)
         select ?, id, ? from benchmark_suites where name = ?`,
    ).run(row.id, now, DEMO_SUITE);
    db.prepare(`update artifacts set tags = ? where id = ?`).run('["e2e-kept"]', row.id);
    return row.id;
  });

  const [v1] = await expectVersionHistory(page, artifactId);
  expect(v1?.version).toBe(1);

  // Unchanged: 0 new versions.
  await scan(page, '2 artifacts found (0 new, 0 new versions)');
  expect(await storedVersions(artifactId)).toEqual([v1]);

  // One edited supporting file: exactly one new version, the next number; v1 is kept.
  write(checklist, '# Checklist, edited\n');
  await scan(page, '2 artifacts found (0 new, 1 new version)');
  const [v2, kept] = await expectVersionHistory(page, artifactId);
  expect(v2?.version).toBe(2);
  expect(v2?.contentHash).not.toBe(v1?.contentHash);
  expect(kept).toEqual(v1);

  // What the user assigned is kept (SPEC-001 principle 15).
  await page.goto(`/artifacts/${artifactId}`);
  await expect(page.getByText('Security', { exact: true })).toBeVisible();
  await expect(page.getByText('e2e-kept', { exact: true })).toBeVisible();
  await page.goto(`/artifacts/${artifactId}?tab=benchmarks`);
  await expect(page.getByRole('link', { name: DEMO_SUITE })).toBeVisible();
});

/**
 * Issue #65 (SPEC-103 §11, FR-103-15): the latest badge, the copy button for the full hash and
 * "first seen at <repo>:<path>@<short sha>". Hosted scans reach the network, so the hosted
 * provenance is seeded (setup only): a GitHub repository with commits, and a version whose
 * repository is gone (the foreign key sets it to null).
 */
const PROVENANCE_ARTIFACT = 'art_e2e_provenance';
const PROVENANCE_REPOSITORY = 'repo_e2e_provenance';
const PROVENANCE_PATH = '.claude/skills/e2e-provenance';
const seeded = [
  {
    version: 3,
    hash: 'c3'.repeat(32),
    repository: PROVENANCE_REPOSITORY,
    commit: 'abcdef0'.padEnd(40, '1'),
  },
  { version: 2, hash: 'b2'.repeat(32), repository: null, commit: null },
  {
    version: 1,
    hash: 'a1'.repeat(32),
    repository: PROVENANCE_REPOSITORY,
    commit: '1234567'.padEnd(40, '0'),
  },
] as const;

function seedProvenance(): Promise<void> {
  return withDatabase((db) => {
    const now = new Date().toISOString();
    db.prepare(
      `insert into repositories (id, provider, name, location, default_branch, sync_status, created_at, updated_at)
         values (?, 'github', 'acme/e2e-provenance', 'https://github.com/acme/e2e-provenance', 'main', 'ok', ?, ?)`,
    ).run(PROVENANCE_REPOSITORY, now, now);
    db.prepare(
      `insert into artifacts (id, slug, name, type, created_at, updated_at)
         values (?, 'e2e-provenance', 'e2e-provenance', 'skill', ?, ?)`,
    ).run(PROVENANCE_ARTIFACT, now, now);
    for (const v of seeded) {
      db.prepare(
        `insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files,
           parsed_metadata, source_repository_id, source_path, source_commit_sha, created_at)
         values (?, ?, ?, ?, 'skill-md', 'SKILL.md', ?, '{}', ?, ?, ?, ?)`,
      ).run(
        `artv_e2e_provenance_${v.version}`,
        PROVENANCE_ARTIFACT,
        v.version,
        v.hash,
        JSON.stringify([{ path: 'SKILL.md', sha256: v.hash, size: 1, content: 'x' }]),
        v.repository,
        PROVENANCE_PATH,
        v.commit,
        now,
      );
    }
  });
}

function removeProvenance(): Promise<void> {
  return withDatabase((db) => {
    db.prepare('delete from artifacts where id = ?').run(PROVENANCE_ARTIFACT);
    db.prepare('delete from repositories where id = ?').run(PROVENANCE_REPOSITORY);
  });
}

test.describe('Versions tab: latest, copy and first seen (issue #65)', () => {
  test.beforeAll(async () => {
    await removeProvenance();
    await seedProvenance();
  });
  test.afterAll(removeProvenance);

  const versionsPath = `/artifacts/${PROVENANCE_ARTIFACT}?tab=versions`;

  test('the newest version carries the latest badge and every version says where it was first seen', async ({
    page,
  }) => {
    await page.goto(versionsPath);
    const rows = page.getByTestId('version-row');
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId('latest-version')).toHaveCount(1);
    await expect(rows.nth(0).getByTestId('latest-version')).toHaveText('latest');
    await expect(rows.nth(0).getByRole('link')).toHaveText('v3');
    await expect(page.getByTestId('version-first-seen')).toHaveText([
      `acme/e2e-provenance:${PROVENANCE_PATH}@abcdef0`,
      `Unknown repository:${PROVENANCE_PATH}`,
      `acme/e2e-provenance:${PROVENANCE_PATH}@1234567`,
    ]);
    // The full commit is in the tooltip of the short one.
    await expect(rows.nth(0).getByTestId('version-first-seen')).toHaveAttribute(
      'title',
      `Commit ${seeded[0].commit}`,
    );
    await expect(rows.nth(1).getByTestId('version-first-seen')).not.toHaveAttribute('title');
  });

  test('Copy puts the full hash on the clipboard, by pointer and by keyboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(versionsPath);
    const rows = page.getByTestId('version-row');

    await rows.nth(0).getByRole('button', { name: 'Copy the full hash of v3' }).click();
    await expect(rows.nth(0).getByRole('status')).toHaveText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(seeded[0].hash);
    // Only the row that was copied says so.
    await expect(rows.nth(2).getByRole('status')).toHaveText('');

    // Keyboard only: from the v1 link, Tab reaches its Copy button; Enter copies.
    await rows.nth(2).getByRole('link', { name: 'v1' }).focus();
    await page.keyboard.press('Tab');
    const copyV1 = rows.nth(2).getByRole('button', { name: 'Copy the full hash of v1' });
    await expect(copyV1).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(rows.nth(2).getByRole('status')).toHaveText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(seeded[2].hash);
  });

  test('a refused clipboard says the hash was not copied and shows it in full', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    });
    await page.goto(versionsPath);
    const row = page.getByTestId('version-row').nth(1);
    await row.getByRole('button', { name: 'Copy the full hash of v2' }).click();
    await expect(row.getByRole('status')).toHaveText(
      `Not copied: the browser blocked the clipboard. Full hash: ${seeded[1].hash}`,
    );
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`fits 320px and has AA text contrast with both copy results in ${theme}`, async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(versionsPath);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await page.evaluate(() => document.fonts.ready);
      const rows = page.getByTestId('version-row');
      await rows.nth(0).getByRole('button', { name: 'Copy the full hash of v3' }).click();
      await expect(rows.nth(0).getByRole('status')).toHaveText('Copied.');
      // A refusal on the next copy: the full hash wraps inside the table's scroll region.
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied'));
      });
      await rows.nth(1).getByRole('button', { name: 'Copy the full hash of v2' }).click();
      await expect(rows.nth(1).getByRole('status')).toContainText('Not copied');

      // The page never scrolls sideways; the table scrolls inside its region.
      expect(
        await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]),
      ).toEqual([320, 320]);
      // Browser QA D1: First seen keeps a readable width (min-w-48) instead of one letter per
      // line; the table scrolls inside its region instead.
      for (const cell of await page.getByTestId('version-first-seen').all()) {
        expect((await cell.boundingBox())?.width).toBeGreaterThanOrEqual(192);
      }
      // Browser QA D2: only the hash breaks anywhere; words in the refusal line stay whole.
      expect(
        await rows
          .nth(1)
          .getByRole('status')
          .evaluate((el) => [getComputedStyle(el).wordBreak, getComputedStyle(el).overflowWrap]),
      ).toEqual(['normal', 'anywhere']);

      const failures = async (state: string) => {
        const scanned = await scanTextContrast(page);
        expect(scanned.length, state).toBeGreaterThan(0);
        return scanned.filter((row) => row.ratio < row.threshold);
      };
      expect.soft(await failures('rest'), `${theme} rest`).toEqual([]);
      const copy = rows.nth(2).getByRole('button', { name: 'Copy the full hash of v1' });
      await copy.scrollIntoViewIfNeeded();
      await copy.hover();
      expect.soft(await failures('hover'), `${theme} hover`).toEqual([]);
      await copy.focus();
      expect.soft(await failures('focus'), `${theme} focus`).toEqual([]);
    });
  }
});
