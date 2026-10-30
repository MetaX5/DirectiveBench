import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
  const rows = page.getByTestId('versions').getByRole('row');
  await expect(rows).toHaveCount(versions.length + 1);
  for (const [index, v] of versions.entries()) {
    const row = rows.nth(index + 1);
    await expect(row.getByRole('cell')).toHaveText([
      `v${v.version}`,
      `${v.contentHash.slice(0, 16)}…`,
      '2',
      skillDir,
      formatDate(v.createdAt),
    ]);
    // The full hash is one hover away (SPEC-103 §11).
    await expect(row.getByRole('cell').nth(1)).toHaveAttribute(
      'title',
      `${v.contentHash} — SHA-256 over the sorted file manifest`,
    );
  }
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
