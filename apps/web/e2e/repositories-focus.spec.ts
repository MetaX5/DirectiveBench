import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { e2eTmpRoot, withDatabase } from './support';

// Issue 243: every form on /repositories posts to a server action that redirects back to the
// page, which re-mounts it, and a job's result arrives by re-render; either way the control that
// was used is gone or disabled. Focus must land on the action's result (its status line, the
// invalid field, the confirmation panel) instead of dropping to <body>. Every flow here is
// keyboard only.

/** The runner polls every second; leave room for a slow CI host. */
const RUNNER_TIMEOUT = 30_000;
const HOLD = 'e2e_hold_focus_scans';

// Its own root outside the other specs' `sources`, so their counts of contained repositories
// stay as they are.
const root = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'focus-')));
const project = join(root, 'focus-project');
const outer = join(root, 'focus-outer');
const inner = join(outer, 'focus-inner');
const held = join(root, 'focus-held');
const gone = join(root, 'focus-gone');

test.beforeAll(() => {
  for (const dir of [project, inner, held, gone]) mkdirSync(dir, { recursive: true });
});

test.afterAll(async () => {
  await withDatabase((db) => {
    db.exec(`drop trigger if exists ${HOLD}`);
    // Leave the shared database as it was found: no pending job, no fixture rows.
    db.prepare(
      `update jobs set status = 'cancelled', finished_at = ?
        where status in ('pending', 'running') and (payload like ? or json_extract(payload,
          '$.repositoryId') in (select id from repositories where location like ?))`,
    ).run(new Date().toISOString(), `%${root}%`, `${root}%`);
    db.prepare('delete from repositories where location like ?').run(`${root}%`);
  });
  rmSync(root, { recursive: true, force: true });
});

/** Presses Tab until `target` has focus, from wherever focus is (a fresh page: the top). */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 150 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Registers `path` with the keyboard only: Tab to the field, type, Enter. */
async function registerByKeyboard(page: Page, path: string): Promise<void> {
  await page.goto('/repositories');
  await tabTo(page, page.getByLabel('Path or GitHub URL'));
  await page.keyboard.type(path);
  await page.keyboard.press('Enter');
}

/** Focus never sits on <body> (the issue's acceptance criterion). */
async function expectFocusNotOnBody(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.activeElement !== null && document.activeElement !== document.body,
    ),
  ).toBe(true);
}

const subject = (name: string, path: string) => `${name} (Local directory, ${path})`;
const row = (page: Page, path: string) => page.getByRole('row').filter({ hasText: path });

test.describe.serial('focus after a form submit on /repositories (issue 243)', () => {
  test('Register: focus goes to the status line, which keeps it until the result', async ({
    page,
  }) => {
    await registerByKeyboard(page, project);
    const status = page.getByTestId('registration-status');
    await expect(status).toBeFocused();
    await expect(status).toHaveText(`Registered ${subject('focus-project', project)}.`, {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(status).toBeFocused();
    await expect(status).toBeInViewport();
  });

  test('Register with an invalid path: focus goes to the Path field', async ({ page }) => {
    // Rejected by the action itself (a redirect with the input).
    await registerByKeyboard(page, 'relative/path');
    const path = page.getByLabel('Path or GitHub URL');
    await expect(page.getByTestId('path-error')).toBeVisible();
    await expect(path).toBeFocused();
    await expect(path).toHaveValue('relative/path');

    // Rejected by the runner (a re-render of the same URL after the check).
    await registerByKeyboard(page, join(root, 'missing'));
    await expect(page.getByTestId('path-error')).toHaveText('No directory exists at this path.', {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(path).toBeFocused();
  });

  test('Register of an overlapping path: focus goes to the confirmation, then to the result', async ({
    page,
  }) => {
    await registerByKeyboard(page, inner);
    await expect(page.getByTestId('registration-status')).toContainText('Registered ', {
      timeout: RUNNER_TIMEOUT,
    });

    await registerByKeyboard(page, outer);
    const confirmation = page.getByTestId('registration-confirmation');
    await expect(confirmation).toContainText(`Register ${outer} anyway?`, {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(confirmation).toBeFocused();

    // Cancel returns focus to Register (a full page load to its id, as Cancel of the Remove panel).
    await page.keyboard.press('Tab'); // Register anyway
    await page.keyboard.press('Tab'); // Cancel
    await expect(confirmation.getByRole('link', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeFocused();

    await registerByKeyboard(page, outer);
    await expect(confirmation).toBeFocused({ timeout: RUNNER_TIMEOUT });
    await page.keyboard.press('Tab');
    await expect(confirmation.getByRole('button', { name: 'Register anyway' })).toBeFocused();
    await page.keyboard.press('Enter');
    const status = page.getByTestId('registration-status');
    await expect(status).toContainText('Registered ', { timeout: RUNNER_TIMEOUT });
    await expect(status).toBeFocused();
  });

  test('Scan: focus goes to the scan status line', async ({ page }) => {
    await page.goto('/repositories');
    await tabTo(
      page,
      page.getByRole('button', { name: `Scan ${subject('focus-project', project)}`, exact: true }),
    );
    await page.keyboard.press('Enter');
    const status = page.getByTestId('scan-status');
    await expect(status).toContainText('Scanned focus-project', { timeout: RUNNER_TIMEOUT });
    await expect(status).toBeFocused();
    await expect(status).toBeInViewport();
  });

  test('Cancel scan: focus goes back to the scan status line when the button is gone', async ({
    page,
  }) => {
    await registerByKeyboard(page, held);
    await expect(page.getByTestId('registration-status')).toContainText('Registered ', {
      timeout: RUNNER_TIMEOUT,
    });
    // The runner never claims a scan of this repository, so it stays pending until cancelled.
    const id = await withDatabase(
      (db) =>
        (db.prepare('select id from repositories where location = ?').get(held) as { id: string })
          .id,
    );
    await withDatabase((db) =>
      db.exec(
        `create trigger if not exists ${HOLD} before update of status on jobs
           when new.status = 'running' and old.type = 'repository-scan'
             and json_extract(old.payload, '$.repositoryId') = '${id}'
           begin select raise(ignore); end`,
      ),
    );

    await page.goto('/repositories');
    await tabTo(
      page,
      page.getByRole('button', { name: `Scan ${subject('focus-held', held)}`, exact: true }),
    );
    await page.keyboard.press('Enter');
    const status = page.getByTestId('scan-status');
    await expect(status).toHaveAttribute('data-state', 'active');
    await expect(status).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('The scan was cancelled. Nothing was changed.', {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toHaveCount(0);
    await expect(status).toBeFocused();
  });

  test('Scan of a repository removed meanwhile: focus goes to the error', async ({ page }) => {
    await registerByKeyboard(page, gone);
    await expect(page.getByTestId('registration-status')).toContainText('Registered ', {
      timeout: RUNNER_TIMEOUT,
    });
    await page.goto('/repositories');
    const scan = page.getByRole('button', {
      name: `Scan ${subject('focus-gone', gone)}`,
      exact: true,
    });
    await tabTo(page, scan);
    await withDatabase((db) => db.prepare('delete from repositories where location = ?').run(gone));
    await page.keyboard.press('Enter');
    const error = page.getByTestId('scan-request-error');
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
  });

  test('Remove repository: focus goes to the result line', async ({ page }) => {
    await page.goto('/repositories');
    await tabTo(
      page,
      row(page, held).getByRole('button', {
        name: `Remove ${subject('focus-held', held)}`,
        exact: true,
      }),
    );
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('remove-panel');
    await expect(panel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Remove repository' })).toBeFocused();
    await page.keyboard.press('Enter');
    const result = page.getByTestId('remove-result');
    await expect(result).toContainText('Repository removed');
    await expect(result).toBeFocused();
    await expect(result).toBeInViewport();
    await expectFocusNotOnBody(page);
  });

  test('focus the user moved elsewhere meanwhile stays where it is', async ({ page }) => {
    await registerByKeyboard(page, join(root, 'also-missing'));
    // While the runner checks the path, the user tabs on to another control.
    await expect(page.getByTestId('registration-status')).toBeFocused();
    await page.keyboard.press('Tab');
    const moved = await page.evaluate(() => document.activeElement?.outerHTML ?? '');
    await expect(page.getByTestId('path-error')).toBeVisible({ timeout: RUNNER_TIMEOUT });
    expect(await page.evaluate(() => document.activeElement?.outerHTML ?? '')).toBe(moved);
  });
});
