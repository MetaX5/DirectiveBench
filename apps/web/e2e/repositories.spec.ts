import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { count, withDatabase } from './support';

/** The runner polls every second; leave room for a slow CI host. */
const REGISTRATION_TIMEOUT = 30_000;

// The runner resolves symlinks (e.g. macOS /var → /private/var), so compare with the real path.
const sources = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-e2e-sources-')));
const repo = join(sources, 'team-skills');
const plain = join(sources, 'plain-rules');

test.beforeAll(() => {
  mkdirSync(join(repo, 'skills', 'review'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  mkdirSync(plain);
  writeFileSync(join(sources, 'notes.txt'), 'not a directory\n');
});

test.afterAll(() => rmSync(sources, { recursive: true, force: true }));

async function register(page: Page, path: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByLabel('Path').fill(path);
  await page.getByRole('button', { name: 'Register' }).click();
}

function repositoryRow(page: Page, location: string) {
  return page.getByRole('row').filter({ hasText: location });
}

function rowsAt(location: string): Promise<number> {
  return withDatabase((db) =>
    count(db, 'select count(*) as n from repositories where location = ?', location),
  );
}

test.describe('repositories', () => {
  test('lists repositories instead of a planned placeholder', async ({ page }) => {
    await page.goto('/repositories');
    await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();
    await expect(page.getByLabel('Path')).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveText([
      'Name',
      'Provider',
      'Location',
      'Branch',
      'Artifacts',
    ]);
    // The demo's bundled examples are a repository too.
    await expect(page.locator('tr[data-provider="bundled-examples"]')).toContainText(
      'Bundled examples',
    );
  });

  test('a path inside a Git work tree is registered at its top level with its branch', async ({
    page,
  }) => {
    await register(page, join(repo, 'skills', 'review') + '/');

    await expect(page.getByTestId('registration-status')).toHaveText(
      `Registered team-skills (Local Git, ${repo}).`,
      { timeout: REGISTRATION_TIMEOUT },
    );
    await expect(page.getByLabel('Path')).toBeEnabled();
    const row = repositoryRow(page, repo);
    await expect(row.getByRole('cell')).toHaveText(['team-skills', 'Local Git', repo, 'main', '0']);
    expect(await rowsAt(repo)).toBe(1);
  });

  test('registering the same repository again returns the existing one', async ({ page }) => {
    await register(page, `${repo}//`);

    await expect(page.getByTestId('registration-status')).toHaveText(
      `team-skills (Local Git, ${repo}) is already registered.`,
      { timeout: REGISTRATION_TIMEOUT },
    );
    expect(await rowsAt(repo)).toBe(1);
  });

  test('a directory outside any work tree is registered as a local directory', async ({ page }) => {
    await register(page, plain);

    await expect(page.getByTestId('registration-status')).toHaveText(
      `Registered plain-rules (Local directory, ${plain}).`,
      { timeout: REGISTRATION_TIMEOUT },
    );
    await expect(repositoryRow(page, plain).getByRole('cell')).toHaveText([
      'plain-rules',
      'Local directory',
      plain,
      '—',
      '0',
    ]);
  });

  test('missing paths and files get a field error and store nothing', async ({ page }) => {
    const before = await withDatabase((db) => count(db, 'select count(*) as n from repositories'));
    const cases = [
      [join(sources, 'missing'), 'No directory exists at this path.'],
      [join(sources, 'notes.txt'), 'This path is a file, not a directory.'],
    ] as const;
    for (const [path, message] of cases) {
      await register(page, path);
      await expect(page.getByTestId('path-error')).toHaveText(message, {
        timeout: REGISTRATION_TIMEOUT,
      });
      await expect(page.getByLabel('Path')).toHaveValue(path);
      await expect(page.getByLabel('Path')).toHaveAttribute('aria-invalid', 'true');
    }

    await register(page, 'relative/path');
    await expect(page.getByTestId('path-error')).toHaveText(
      'Enter an absolute path, for example /home/you/project or ~/project.',
    );
    await expect(page.getByLabel('Path')).toHaveValue('relative/path');

    expect(await withDatabase((db) => count(db, 'select count(*) as n from repositories'))).toBe(
      before,
    );
  });
});
