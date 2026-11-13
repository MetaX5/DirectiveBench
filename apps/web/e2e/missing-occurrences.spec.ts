import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { DEMO_ARTIFACT, MOCK_LABEL, e2eTmpRoot, withDatabase } from './support';

// SPEC-125 Phase 1 (§15, §21 step 5): a deleted skill is marked missing by a rescan, its page says
// so and keeps its history, it comes back when restored, and an empty scan marks nothing (A7).
// The fixture repository has a rule file and two skills, so deleting one leaves artifacts.
// Phase 2 (§11.3 D26): after the empty scan the repository is removed through the Risky-action
// panel (Cancel first), which leaves its artifacts missing with their history (AC-3, AC-10).

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

function repositoryIdOf(): Promise<string | undefined> {
  return withDatabase(
    (db) =>
      (
        db.prepare('select id from repositories where name = ?').get(REPOSITORY) as
          { id: string } | undefined
      )?.id,
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
  /** The fixture's artifacts, which outlive the repository once it is removed (Phase 2). */
  let fixtureArtifacts: string[] = [];
  /** The fixture repository's id, kept for the issue 216 check after it is removed. */
  let removedRepositoryId: string | undefined;

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
    fixtureArtifacts = await withDatabase((db) =>
      (
        db
          .prepare(
            `select o.artifact_id as id from artifact_occurrences o
               join repositories r on r.id = o.repository_id where r.name = ?`,
          )
          .all(REPOSITORY) as { id: string }[]
      ).map((row) => row.id),
    );
  });

  // Other spec files count artifacts and jobs (lesson 2026-11-10): leave the database as found.
  test.afterAll(async () => {
    await setDemoStatus('active');
    await withDatabase((db) => {
      const repository = db
        .prepare('select id from repositories where name = ?')
        .get(REPOSITORY) as { id: string } | undefined;
      if (repository) db.prepare('delete from repositories where id = ?').run(repository.id);
      const removeArtifact = db.prepare('delete from artifacts where id = ?');
      for (const id of fixtureArtifacts) removeArtifact.run(id);
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
      page.getByText('Planned: not implemented: private repositories, GitLab'),
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
    await expect(page.getByTestId('occurrences').getByRole('cell').nth(4)).toHaveText('missing');
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
    await expect(page.getByTestId('occurrences').getByRole('cell').nth(4)).toHaveText('active');
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
      /, 0 artifacts found \(0 new, 0 new versions\), 0 errors\. No artifacts found, so the 3 found before were not marked missing\. Check that the location is mounted and has the expected files\. If they were deleted on purpose, remove the repository\.$/,
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

  test('Remove opens the panel with the counts; Cancel writes nothing and returns to the row', async ({
    page,
  }) => {
    const id = (await repositoryIdOf()) as string;
    // The bundled examples have no Remove (AC-7, A15); the fixture row has Scan then Remove.
    await page.goto('/repositories');
    await expect(
      page.locator('tr[data-provider="bundled-examples"]').getByRole('button'),
    ).toHaveCount(0);
    const row = page.locator(`tr[id="repository-${id}"]`);
    await row.getByRole('button', { name: `Remove ${REPOSITORY}` }).click();

    // A GET form with the panel as fragment target: a full page load (D12, D19).
    await expect(page).toHaveURL(new RegExp(`/repositories\\?remove=${id}#remove-panel$`));
    const panel = page.getByTestId('remove-panel');
    await expect(panel).toHaveAttribute('role', 'alert');
    await expect(panel.locator('p').first()).toHaveText(
      `Remove ${REPOSITORY} (Local directory, ${root})?`,
    );
    await expect(panel.getByRole('listitem')).toHaveText([
      'Its 3 occurrences are deleted from DirectiveBench.',
      '3 artifacts are then missing from every repository. Their versions, categories, notes and benchmark results are kept.',
      `Nothing in ${root} is changed.`,
      'Registering it again later creates new artifacts. A skill or rule whose exact content is still recorded in another local repository is matched to its existing artifact instead.',
    ]);
    // Keyboard navigation starts at the panel after the fragment: Tab reaches the confirm, then
    // Cancel (D19, D24).
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Remove repository' })).toBeFocused();
    await page.keyboard.press('Tab');
    const cancel = panel.getByRole('link', { name: 'Cancel' });
    await expect(cancel).toBeFocused();

    // Contrast in both themes with the panel open, also with the confirm hovered.
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      for (const state of ['rest', 'hover'] as const) {
        if (state === 'hover')
          await page.getByRole('button', { name: 'Remove repository' }).hover();
        const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
        expect(failures, `${theme} ${state}`).toEqual([]);
      }
      await page.mouse.move(0, 0);
    }
    // At 320px the question and reasons wrap without a horizontal page scroll.
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Cancel writes nothing and returns to the row: the next Tab reaches its Scan, then Remove.
    await cancel.click();
    await expect(page).toHaveURL(new RegExp(`/repositories#repository-${id}$`));
    await expect(page.getByTestId('remove-panel')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: `Scan ${REPOSITORY}` })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: `Remove ${REPOSITORY}` })).toBeFocused();
    expect(await repositoryIdOf()).toBe(id);
    expect((await statusesOf()).every((o) => o.status === 'active')).toBe(true);
  });

  test('a confirm for a repository removed meanwhile shows the alert in view at 320px', async ({
    page,
  }) => {
    // QA finding on PR 217: the error redirects carried no fragment, so at 320px the alert sat
    // below the Register card. A repository seeded for this check is deleted behind the panel.
    const stale = 'repo_stale_e2e';
    await withDatabase((db) =>
      db
        .prepare(
          `insert into repositories (id, provider, name, location, created_at, updated_at)
           values (?, 'local-directory', 'stale-e2e', ?, 't', 't')`,
        )
        .run(stale, join(sources, 'stale')),
    );
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`/repositories?remove=${stale}#remove-panel`);
      await expect(page.getByTestId('remove-panel')).toBeVisible();
      await withDatabase((db) => db.prepare('delete from repositories where id = ?').run(stale));
      await page.getByRole('button', { name: 'Remove repository' }).click();
      const alert = page.getByTestId('remove-result');
      await expect(alert).toHaveText(
        'That repository is no longer registered. Nothing was removed.',
      );
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(page).toHaveURL(/\/repositories\?removeError=not-found#remove-result$/);
      await expect(alert).toBeInViewport();
    } finally {
      await withDatabase((db) => db.prepare('delete from repositories where id = ?').run(stale));
    }
  });

  test('the panel of a GitHub repository says its download is deleted from the cache (issue 59)', async ({
    page,
  }) => {
    // Issue 59 J9: the runner deletes a removed repository's cache. A row seeded for this check;
    // no network and no registration job.
    const hosted = 'repo_issue59E2eRows0';
    await withDatabase((db) =>
      db
        .prepare(
          `insert into repositories (id, provider, name, location, default_branch, created_at, updated_at)
           values (?, 'github', 'rules-e2e', 'https://github.com/acme/rules-e2e', 'main', 't', 't')`,
        )
        .run(hosted),
    );
    try {
      await page.goto(`/repositories?remove=${hosted}#remove-panel`);
      const panel = page.getByTestId('remove-panel');
      await expect(panel.getByRole('listitem')).toHaveText([
        'It has no occurrences.',
        "The copy downloaded from GitHub is deleted from DirectiveBench's cache. Nothing on GitHub is changed.",
      ]);
      await expect(panel).not.toContainText('planned');
    } finally {
      await withDatabase((db) => db.prepare('delete from repositories where id = ?').run(hosted));
    }
  });

  test('confirming removes the repository; its artifacts are missing with their history (AC-3, AC-10)', async ({
    page,
  }) => {
    const id = (await repositoryIdOf()) as string;
    removedRepositoryId = id;
    const gone = await artifactIdOf(GONE);
    // At 320px the result line is below the Register card, so the redirect's fragment matters.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/repositories?remove=${id}#remove-panel`);
    await page.getByRole('button', { name: 'Remove repository' }).click();

    const result = page.getByTestId('remove-result');
    await expect(result).toHaveText(
      'Repository removed: 3 occurrences deleted, 3 artifacts now missing from every repository. Their history is kept.',
    );
    await expect(result).toHaveAttribute('role', 'status');
    await expect(result).toHaveClass(/text-success-foreground/);
    // The Server Action redirect keeps the fragment and scrolls the line into view (D19).
    await expect(page).toHaveURL(
      /\/repositories\?removedOccurrences=3&missingArtifacts=3#remove-result$/,
    );
    await expect(result).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('remove-panel')).toHaveCount(0);
    await expect(page.locator(`tr[id="repository-${id}"]`)).toHaveCount(0);
    expect(await repositoryIdOf()).toBeUndefined();
    expect(await statusesOf()).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });

    // The list keeps the artifact, labelled Missing with 0 occurrences.
    await page.goto(`/artifacts?q=${GONE}`);
    const cells = page.getByRole('row').filter({ hasText: GONE }).getByRole('cell');
    await expect(cells.nth(4)).toHaveText('Missing');
    await expect(cells.nth(5)).toHaveText('0');

    // The page: the "repositories were removed" note, the D21 sentence, versions kept.
    await page.goto(`/artifacts/${gone}`);
    await expect(page.getByTestId('missing-note')).toHaveText(
      'Missing: the repositories it was found in were removed. Its versions, categories, notes and benchmark results are kept.',
    );
    await expect(page.getByTestId('no-occurrences')).toHaveText(
      'No occurrences left: the repositories it was found in were removed.',
    );
    await expect(page.getByTestId('occurrences')).toHaveCount(0);
    await page.goto(`/artifacts/${gone}?tab=versions`);
    await expect(page.getByRole('main')).toContainText('v1');
    await expect(page.getByRole('main')).toContainText('Unknown repository');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/artifacts/${gone}`);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
      expect(failures, theme).toEqual([]);
    }

    // The panel for a repository that is gone: no panel, one status line.
    await page.goto(`/repositories?remove=${id}`);
    await expect(page.getByTestId('remove-panel')).toHaveCount(0);
    await expect(page.getByTestId('remove-result')).toHaveText(
      'That repository is no longer registered.',
    );
  });

  test('a bookmark that filters by the removed repository lists everything and says why (issue 216)', async ({
    page,
  }) => {
    // The previous test removed the fixture repository; its id is still a well-formed filter.
    const id = removedRepositoryId as string;
    expect(id).toMatch(/^repo_/);
    await page.goto(`/artifacts?repository=${id}`);
    await expect(page.getByTestId('filter-notice')).toHaveText(
      'Ignored the repository in the URL: it is not registered.',
    );
    await expect(page.getByTestId('filter-notice')).toHaveAttribute('role', 'status');
    // The select shows "All", which is now true: the whole registry is listed.
    await expect(page.locator('select[name="repository"]')).toHaveValue('');
    await expect(page.getByRole('link', { name: DEMO_ARTIFACT, exact: true })).toBeVisible();
    await expect(page.getByText('No artifacts match the filters')).toHaveCount(0);
    // The ignored filter gates the bulk row like an invalid value (E2).
    await expect(page.getByTestId('bulk-category')).toHaveText(
      'Fix or clear the filters in the URL before changing categories for the whole list.',
    );
    await expect(page.getByTestId('bulk-category').getByRole('button')).toHaveCount(0);
    await page.getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/artifacts$/);
    await expect(page.getByTestId('filter-notice')).toHaveCount(0);
  });
});
