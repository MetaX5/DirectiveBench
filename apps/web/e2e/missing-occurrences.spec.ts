import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { DEMO_ARTIFACT, MOCK_LABEL, e2eTmpRoot, withDatabase } from './support';

// SPEC-125 Phase 1 (§15, §21 step 5): a deleted skill is marked missing by a rescan, its page says
// so and keeps its history, it comes back when restored, and an empty scan marks nothing (A7).
// The fixture repository has a rule file and two skills, so deleting one leaves artifacts.

/** The runner polls every second; leave room for a slow CI host. */
const RUNNER_TIMEOUT = 30_000;
const REPOSITORY = 'missing-e2e';
const GONE = 'missing-e2e-gone';
const KEPT = 'missing-e2e-kept';
const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'missing-')));
const root = join(sources, REPOSITORY);
const parked = join(sources, 'parked');

function write(relPath: string, content: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), content);
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Missing fixture ${name}.\n---\n# ${name}\n`;
}

async function scan(page: Page): Promise<void> {
  await page.goto('/repositories');
  await page.getByRole('button', { name: `Scan ${REPOSITORY}` }).click();
  await expect(page.getByTestId('scan-status')).toContainText(`Scanned ${REPOSITORY}:`, {
    timeout: RUNNER_TIMEOUT,
  });
}

function artifactIdOf(name: string): Promise<string> {
  return withDatabase(
    (db) => (db.prepare('select id from artifacts where name = ?').get(name) as { id: string }).id,
  );
}

function statusesOf(): Promise<{ path: string; status: string }[]> {
  return withDatabase(
    (db) =>
      db
        .prepare(
          `select o.path, o.status from artifact_occurrences o
             join repositories r on r.id = o.repository_id
            where r.name = ? order by o.path`,
        )
        .all(REPOSITORY) as { path: string; status: string }[],
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Sets the demo artifact's occurrences to `removed` (or back) for a check; setup only (D11). */
async function setDemoStatus(status: 'active' | 'removed'): Promise<string> {
  return withDatabase((db) => {
    const { id } = db.prepare('select id from artifacts where slug = ?').get(DEMO_ARTIFACT) as {
      id: string;
    };
    db.prepare('update artifact_occurrences set status = ? where artifact_id = ?').run(status, id);
    return id;
  });
}

test.describe.serial('missing occurrences (SPEC-125)', () => {
  /** Jobs that existed before the fixture repository was registered and scanned. */
  let jobsBefore = new Set<string>();

  test.beforeAll(async ({ browser }) => {
    jobsBefore = await withDatabase(
      (db) =>
        new Set((db.prepare('select id from jobs').all() as { id: string }[]).map((j) => j.id)),
    );
    write('AGENTS.md', '# Missing fixture rules\n');
    write(`.agents/skills/${GONE}/SKILL.md`, skill(GONE));
    write(`.agents/skills/${KEPT}/SKILL.md`, skill(KEPT));
    const page = await browser.newPage();
    await page.goto('/repositories');
    await page.getByLabel('Path').fill(root);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('registration-status')).toContainText(
      `Registered ${REPOSITORY}`,
      { timeout: RUNNER_TIMEOUT },
    );
    await scan(page);
    await page.close();
  });

  // Other spec files count artifacts and jobs (lesson 2026-11-10): leave the database as found.
  test.afterAll(async () => {
    await setDemoStatus('active');
    await withDatabase((db) => {
      const repository = db
        .prepare('select id from repositories where name = ?')
        .get(REPOSITORY) as { id: string } | undefined;
      if (repository) {
        db.prepare(
          `delete from artifacts where id in (
             select artifact_id from artifact_occurrences where repository_id = ?)`,
        ).run(repository.id);
        db.prepare('delete from repositories where id = ?').run(repository.id);
      }
      const remove = db.prepare('delete from jobs where id = ?');
      for (const { id } of db.prepare('select id from jobs').all() as { id: string }[]) {
        if (!jobsBefore.has(id)) remove.run(id);
      }
    });
    rmSync(sources, { recursive: true, force: true });
  });

  test('a deleted skill is marked missing; its list row and page say so and keep its history', async ({
    page,
  }) => {
    renameSync(join(root, '.agents/skills', GONE), parked);
    await scan(page);
    const status = page.getByTestId('scan-status');
    await expect(status).toHaveText(
      /^Scanned missing-e2e: \d+ files in [\d.]+ (ms|s), 2 artifacts found \(0 new, 0 new versions\), 0 errors\. 1 no longer found \(marked missing\)\.$/,
    );
    await expect(status).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('scan-explanation')).toContainText(
      'A file that a later scan does not find is marked missing; its history is kept.',
    );
    await expect(page.getByTestId('scan-explanation')).not.toContainText('—');
    await expect(
      page.getByText(
        'Planned: not implemented: private repositories, GitLab, removing a repository',
      ),
    ).toBeVisible();
    expect(await statusesOf()).toEqual([
      { path: '.agents/skills/missing-e2e-gone', status: 'removed' },
      { path: '.agents/skills/missing-e2e-kept', status: 'active' },
      { path: 'AGENTS.md', status: 'active' },
    ]);

    // The list keeps it, with Missing in the Repository cell and 0 occurrences (D5).
    await page.goto(`/artifacts?q=${GONE}`);
    const row = page.getByRole('row').filter({ hasText: GONE });
    const cells = row.getByRole('cell');
    const repositoryCell = cells.nth(4);
    await expect(repositoryCell).toHaveText('Missing');
    await expect(repositoryCell).not.toHaveAttribute('title');
    await expect(cells.nth(5)).toHaveText('0');
    await page.goto(`/artifacts?q=${KEPT}`);
    await expect(
      page.getByRole('row').filter({ hasText: KEPT }).getByRole('cell').nth(4),
    ).toHaveText(REPOSITORY);

    // The page: a muted Badge after type and format, the note on every tab, "missing" status.
    const id = await artifactIdOf(GONE);
    await page.goto(`/artifacts/${id}`);
    await expect(page.getByRole('main').getByText('Missing', { exact: true })).toBeVisible();
    const note = page.getByTestId('missing-note');
    await expect(note).toHaveAttribute('role', 'note');
    await expect(note).toHaveText(
      /^Missing: no registered repository contained this artifact in its last scan\. Last found on \d{2} \w{3} \d{4}, \d{2}:\d{2} UTC\. Its versions, categories, notes and benchmark results are kept, and it becomes active again when a scan finds it at the same path\.$/,
    );
    await expect(page.getByTestId('occurrences').getByRole('cell').nth(3)).toHaveText('missing');
    for (const tab of ['versions', 'metadata', 'evaluations']) {
      await page.goto(`/artifacts/${id}?tab=${tab}`);
      await expect(page.getByTestId('missing-note')).toBeVisible();
    }
    await page.goto(`/artifacts/${id}?tab=versions`);
    await expect(page.getByRole('main')).toContainText('v1');
  });

  test('a restored skill is found again and active, with the same artifact', async ({ page }) => {
    const id = await artifactIdOf(GONE);
    renameSync(parked, join(root, '.agents/skills', GONE));
    await scan(page);
    await expect(page.getByTestId('scan-status')).toHaveText(
      /, 3 artifacts found \(0 new, 0 new versions\), 0 errors\. 1 found again\.$/,
    );
    expect(await artifactIdOf(GONE)).toBe(id);
    expect((await statusesOf()).every((o) => o.status === 'active')).toBe(true);
    await page.goto(`/artifacts/${id}`);
    await expect(page.getByTestId('missing-note')).toHaveCount(0);
    await expect(page.getByTestId('occurrences').getByRole('cell').nth(3)).toHaveText('active');
    await page.goto(`/artifacts?q=${GONE}`);
    await expect(
      page.getByRole('row').filter({ hasText: GONE }).getByRole('cell').nth(4),
    ).toHaveText(REPOSITORY);
  });

  test('an empty scan marks nothing and warns, with AA contrast in both themes', async ({
    page,
  }) => {
    rmSync(join(root, '.agents'), { recursive: true });
    rmSync(join(root, 'AGENTS.md'));
    await scan(page);
    const status = page.getByTestId('scan-status');
    await expect(status).toHaveText(
      /, 0 artifacts found \(0 new, 0 new versions\), 0 errors\. No artifacts found, so the 3 found before were not marked missing\. Check that the location is mounted and has the expected files\.$/,
    );
    await expect(status).toHaveAttribute('data-state', 'warning');
    await expect(status).toHaveClass(/text-warning-foreground/);
    expect((await statusesOf()).every((o) => o.status === 'active')).toBe(true);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const failures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
      expect(failures, theme).toEqual([]);
    }
    // At 320px the long line wraps without a horizontal page scroll.
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a missing artifact's evaluation history stays visible, and the pages fit 320px and keyboard use", async ({
    page,
  }) => {
    const id = await setDemoStatus('removed');
    try {
      await page.goto(`/artifacts/${id}?tab=evaluations`);
      await expect(page.getByTestId('missing-note')).toBeVisible();
      await expect(page.getByRole('main').getByText(MOCK_LABEL).first()).toBeVisible();
      // No new focusable element (D10): Tab from the top of main goes through the tabs as before.
      await page.goto(`/artifacts/${id}`);
      await page.getByRole('heading', { level: 1 }).click();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Overview' })).toBeFocused();
      for (const path of [`/artifacts/${id}`, '/artifacts']) {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto(path);
        await expect(page.getByText('Missing', { exact: true }).first()).toBeVisible();
        expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
      }
    } finally {
      await setDemoStatus('active');
    }
  });
});
