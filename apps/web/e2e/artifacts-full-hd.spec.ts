import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { DEMO_ARTIFACT, MOCK_LABEL, withDatabase } from './support';

/**
 * Issue 122: at 1920x1080 with the sidebar visible, every column of the Artifacts table fits
 * without horizontal scrolling. Next to the demo artifact (with its mock evaluation) a seeded
 * instruction carries the widest realistic values: a nested path as its name (agents-md,
 * claude-md and similar artifacts are named `<dir>/<file>`), a long description, four
 * categories and two repositories with long names without spaces or hyphens.
 */

const ARTIFACT = 'art_e2e122fullhd';
const VERSION = 'artv_e2e122fullhd';
const REPOSITORIES = [
  { id: 'repo_e2e122a', name: 'client_platform_monorepo_frontend_services' },
  { id: 'repo_e2e122b', name: 'team-shared-agent-skills-library' },
];
const LONG_NAME = 'packages/benchmark-engine/src/fixtures/typescript/nested/AGENTS.md';
const CATEGORIES = ['code-quality', 'security', 'backend', 'documentation'];
/**
 * SPEC-126 §11.4 G1, G17: a pair of rules with a long snake_case name. Seeded with two formats
 * (not duplicates), then the second gets the first's format, so the same rows are measured
 * without and with the "Possible duplicate" Badge.
 */
const PAIR_NAME = 'enforce_strict_input_validation_for_every_public_endpoint_handler';
const PAIR = ['art_e2e126pair1', 'art_e2e126pair2'] as const;

test.beforeAll(() =>
  withDatabase((db) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO artifacts (id, slug, name, type, description, created_at, updated_at)
       VALUES (?, ?, ?, 'instruction', ?, ?, ?)`,
    ).run(
      ARTIFACT,
      'packages-benchmark-engine-src-fixtures-typescript-nested-agents-md',
      LONG_NAME,
      'Use when writing code that parses or accepts user-supplied input from forms, files, ' +
        'HTTP requests and environment variables; enforces strict validation with explicit errors.',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO artifact_versions
         (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
       VALUES (?, ?, 1, ?, 'agents-md', 'AGENTS.md', '[]', '{}', ?)`,
    ).run(VERSION, ARTIFACT, 'c'.repeat(64), now);
    for (const [index, repository] of REPOSITORIES.entries()) {
      db.prepare(
        `INSERT INTO repositories (id, provider, name, location, created_at, updated_at)
         VALUES (?, 'local-directory', ?, ?, ?, ?)`,
      ).run(repository.id, repository.name, `/e2e/122/${repository.name}`, now, now);
      db.prepare(
        `INSERT INTO artifact_occurrences
           (id, artifact_id, repository_id, path, latest_version_id, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`occ_e2e122${index}`, ARTIFACT, repository.id, LONG_NAME, VERSION, now, now, now);
    }
    for (const [index, id] of PAIR.entries()) {
      db.prepare(
        `INSERT INTO artifacts (id, slug, name, type, created_at, updated_at)
         VALUES (?, ?, ?, 'rule', ?, ?)`,
      ).run(id, `${PAIR_NAME.replaceAll('_', '-')}-${index + 1}`, PAIR_NAME, now, now);
      db.prepare(
        `INSERT INTO artifact_versions
           (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
         VALUES (?, ?, 1, ?, ?, ?, '[]', '{}', ?)`,
      ).run(
        `artv_${id}`,
        id,
        String(index).repeat(64),
        index === 0 ? 'cursor-rule' : 'claude-rule',
        `${PAIR_NAME}.md`,
        now,
      );
    }
    for (const slug of CATEGORIES) {
      db.prepare(
        `INSERT INTO artifact_categories (artifact_id, category_id, created_at)
         SELECT ?, id, ? FROM categories WHERE slug = ?`,
      ).run(ARTIFACT, now, slug);
    }
  }),
);

test.afterAll(() =>
  withDatabase((db) => {
    db.prepare('DELETE FROM artifacts WHERE id = ?').run(ARTIFACT);
    for (const id of PAIR) db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    for (const repository of REPOSITORIES)
      db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
  }),
);

/** Gives the second rule of the pair the first one's format: they become possible duplicates. */
function setPairDuplicated(duplicated: boolean) {
  return withDatabase((db) =>
    db
      .prepare('UPDATE artifact_versions SET format = ? WHERE artifact_id = ?')
      .run(duplicated ? 'cursor-rule' : 'claude-rule', PAIR[1]),
  );
}

/** The rendered width of the Name column header. */
function nameColumnWidth(page: Page) {
  return page
    .getByRole('columnheader', { name: 'Name' })
    .evaluate((element) => element.getBoundingClientRect().width);
}

/** [scrollWidth, clientWidth] of the document and of the table's scroll container. */
function widths(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-slot="table-container"]');
    const root = document.documentElement;
    return {
      document: [root.scrollWidth, root.clientWidth],
      table: container ? [container.scrollWidth, container.clientWidth] : null,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`the Artifacts table fits a 1920x1080 screen without horizontal scrolling in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: theme });
    // The same rows without the "Possible duplicate" Badges first (SPEC-126 §11.4 G17).
    await page.goto('/artifacts');
    await expect(page.getByRole('link', { name: PAIR_NAME })).toHaveCount(2);
    await expect(page.getByTestId('possible-duplicate')).toHaveCount(0);
    const nameWidthWithout = await nameColumnWidth(page);
    await setPairDuplicated(true);
    try {
      await page.goto('/artifacts');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await expect(page.getByRole('navigation').first()).toBeVisible();
      const badges = page.getByTestId('possible-duplicate');
      await expect(badges).toHaveCount(2);
      for (const badge of await badges.all()) {
        expect(await badge.evaluate((element) => element.getClientRects().length)).toBe(1);
      }
      expect(await nameColumnWidth(page)).toBe(nameWidthWithout);
      await expectTableFits(page, theme, testInfo);
    } finally {
      await setPairDuplicated(false);
    }
  });
}

/** Issue 122: the document and the table do not scroll, and every column is visible. */
async function expectTableFits(page: Page, theme: 'light' | 'dark', testInfo: TestInfo) {
  const table = page.getByRole('table');
  const seeded = table.getByRole('row').filter({ hasText: LONG_NAME });
  await expect(seeded.getByRole('link', { name: LONG_NAME })).toBeVisible();
  for (const name of ['Code Quality', 'Security', 'Backend', 'Documentation'])
    await expect(seeded.getByText(name, { exact: true })).toBeVisible();
  await expect(seeded.getByText(`${REPOSITORIES[0]!.name} +1`)).toBeVisible();
  const demo = table.getByRole('row').filter({ hasText: DEMO_ARTIFACT }).first();
  await expect(demo.getByText(MOCK_LABEL)).toBeVisible();
  // The mock label stays on one line, and its flask icon keeps its 12px size.
  const badge = demo.locator('[data-slot="badge"]').filter({ hasText: MOCK_LABEL });
  const label = await badge.evaluate((element) => {
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const icon = element.querySelector('svg')!.getBoundingClientRect();
    return { lines: range.getClientRects().length, icon: [icon.width, icon.height] };
  });
  expect(label.lines).toBe(1);
  expect(label.icon).toEqual([12, 12]);

  const { document: root, table: container } = await widths(page);
  expect(root[0]).toBeLessThanOrEqual(root[1]!);
  expect(container).not.toBeNull();
  expect(container![0]).toBeLessThanOrEqual(container![1]!);

  // Every column, Status included, lies inside the visible part of the table.
  const box = await page.locator('[data-slot="table-container"]').boundingBox();
  for (const header of await table.getByRole('columnheader').all()) {
    const cell = await header.boundingBox();
    expect(cell!.x + cell!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  }
  await expect(table.getByRole('columnheader', { name: 'Status' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath(`artifacts-full-hd-${theme}.png`) });
}

test('other pages keep the 72rem content width at 1920px', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const path of ['/', '/repositories', '/results']) {
    await page.goto(path);
    const width = await page.locator('main').evaluate((main) => main.getBoundingClientRect().width);
    expect(width, path).toBe(72 * 16);
  }
  await page.goto('/artifacts');
  const wide = await page.locator('main').evaluate((main) => main.getBoundingClientRect().width);
  expect(wide).toBe(96 * 16);
});
