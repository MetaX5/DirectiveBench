import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { count, e2eTmpRoot, withDatabase } from './support';

// Issue 58: the branch of a public GitHub repository, chosen at registration or changed later.
// The suite never reaches the network: jobs that would ask GitHub are held pending by a temporary
// SQLite trigger (the runner's claim is ignored), and the test plays the runner by recording the
// outcome. The runner's git side is covered against local bare repositories in packages/runner.

const RUNNER_TIMEOUT = 30_000;
const HOLD = 'e2e_hold_github_jobs';
const BRANCH_RULE =
  'A branch name may use letters, digits, ".", "_", "-" and "/". It cannot start with "-" or ".", contain ".." or a space, or end with ".lock".';

const REPOS = [
  ['repo_e2e58_a', 'acme/e2e58-skills', 'main', null, 'main', 'ok', null],
  ['repo_e2e58_b', 'acme/e2e58-rules', 'main', 'release/2.0', 'main', 'ok', null],
  [
    'repo_e2e58_c',
    'acme/e2e58-prompts',
    'trunk',
    'legacy',
    'legacy',
    'error',
    'The branch legacy does not exist in the repository any more. Change the branch, or leave it empty to use the default branch.',
  ],
] as const;
const location = (name: string) => `https://github.com/${name}`;
const subject = (name: string) => `${name} (GitHub, ${location(name)})`;

const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'branch-sources-')));
const localRepo = join(sources, 'e2e58-local');

test.beforeAll(async () => {
  mkdirSync(localRepo);
  execFileSync('git', ['init', '-q', '-b', 'feature/x'], { cwd: localRepo });
  await withDatabase((db) => {
    // Every branch change, and every registration of a URL, stays pending: nothing reaches GitHub.
    db.exec(
      `create trigger if not exists ${HOLD} before update of status on jobs
         when new.status = 'running' and (old.type = 'repository-branch'
           or (old.type = 'repository-registration' and json_extract(old.payload, '$.url') is not null))
         begin select raise(ignore); end`,
    );
    const now = new Date().toISOString();
    const insert = db.prepare(
      `insert into repositories (id, provider, name, location, default_branch, selected_branch, scanned_branch, last_sync_at, sync_status, sync_error, created_at, updated_at)
       values (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, name, def, selected, scanned, status, error] of REPOS) {
      insert.run(id, name, location(name), def, selected, scanned, now, status, error, now, now);
    }
  });
});

test.afterAll(async () => {
  await withDatabase((db) => {
    db.exec(`drop trigger if exists ${HOLD}`);
    // Leave the shared database as it was found (lesson 2026-11-13): no pending job, no rows.
    db.exec(
      `update jobs set status = 'cancelled', finished_at = '${new Date().toISOString()}'
        where status in ('pending', 'running') and (type = 'repository-branch'
          or (type = 'repository-registration' and json_extract(payload, '$.url') like '%e2e58%'))`,
    );
    db.exec("delete from repositories where id like 'repo_e2e58_%'");
    db.prepare('delete from repositories where location = ?').run(localRepo);
  });
  rmSync(sources, { recursive: true, force: true });
});

const branchField = (page: Page) => page.getByLabel('Branch (optional)');
const panelField = (page: Page) => page.getByTestId('branch-panel').getByLabel('Branch');
const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: location(name) });

/** Plays the runner for a held job: records its result. */
async function finish(jobId: string, result: Record<string, unknown>): Promise<void> {
  await withDatabase((db) => {
    db.prepare(
      "update jobs set status = 'completed', result = ?, finished_at = ? where id = ?",
    ).run(JSON.stringify(result), new Date().toISOString(), jobId);
  });
}

test.describe.serial('choose the branch of a GitHub repository (issue 58)', () => {
  test('the list says which branch each repository uses and whether it is the default', async ({
    page,
  }) => {
    await page.goto('/repositories');
    await expect(row(page, 'acme/e2e58-skills').getByRole('cell').nth(3)).toHaveText(
      'mainDefault branchChange',
    );
    await expect(row(page, 'acme/e2e58-rules').getByRole('cell').nth(3)).toHaveText(
      'release/2.0Chosen. Default: mainChange',
    );
    await expect(row(page, 'acme/e2e58-rules').getByRole('cell').nth(5)).toContainText(
      'That scan read main: scan again to read release/2.0.',
    );
    await expect(row(page, 'acme/e2e58-prompts').getByRole('cell').nth(5)).toHaveText(
      `Failed: ${REPOS[2][6]}`,
    );
    // Each GitHub row has a uniquely named Change branch; no placeholder in the Branch field.
    for (const [, name] of REPOS) {
      await expect(
        page.getByRole('button', { name: `Change branch of ${subject(name)}`, exact: true }),
      ).toHaveCount(1);
    }
    await expect(branchField(page)).not.toHaveAttribute('placeholder');
    await expect(branchField(page)).toHaveAccessibleDescription(
      'GitHub only. Empty: the default branch.',
    );
    // The inline buttons line up with the inputs (32px, same top).
    const input = await branchField(page).boundingBox();
    const button = await page.getByRole('button', { name: 'Register' }).boundingBox();
    expect(button?.height).toBe(input?.height);
    expect(button?.y).toBe(input?.y);
  });

  test('a local repository with a branch, and an invalid branch, get an error under the Branch field', async ({
    page,
  }) => {
    const jobsBefore = await withDatabase((db) => count(db, 'select count(*) as n from jobs'));
    await page.goto('/repositories');
    await page.getByLabel('Path or GitHub URL').fill(localRepo);
    await branchField(page).fill('main');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('branch-error')).toHaveText(
      'A local repository is scanned from its working tree; leave Branch empty.',
    );
    await expect(branchField(page)).toBeFocused();
    await expect(branchField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue(localRepo);

    await page.getByLabel('Path or GitHub URL').fill('https://github.com/Acme/E2E58-New');
    await branchField(page).fill('-upload-pack=x');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('branch-error')).toHaveText(BRANCH_RULE);
    await expect(branchField(page)).toBeFocused();
    await expect(branchField(page)).toHaveValue('-upload-pack=x');
    await expect(branchField(page)).toHaveAccessibleDescription(
      `${BRANCH_RULE} GitHub only. Empty: the default branch.`,
    );
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue(
      'https://github.com/acme/e2e58-new',
    );
    // A value that may carry credentials is never echoed.
    const token = 'ghp_e2eBranchTokenAbcdefghijklmnop';
    await branchField(page).fill(`x@${token}`);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('branch-error')).toHaveText(BRANCH_RULE);
    expect(page.url()).not.toContain(token);
    await expect(branchField(page)).toHaveValue('');
    expect(await page.content()).not.toContain(token);
    expect(await withDatabase((db) => count(db, 'select count(*) as n from jobs'))).toBe(
      jobsBefore,
    );

    // Without a branch the local repository registers as before.
    await page.getByLabel('Path or GitHub URL').fill(localRepo);
    await branchField(page).fill('');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('registration-status')).toContainText('Registered e2e58-local', {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(
      page.getByRole('row').filter({ hasText: localRepo }).getByRole('cell').nth(3),
    ).toHaveText('feature/xChecked out (scans the working tree)');
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: localRepo })
        .getByRole('button', { name: /^Change branch/ }),
    ).toHaveCount(0);
  });

  test('registering a URL with a branch asks GitHub about it and shows a missing branch under the field', async ({
    page,
  }) => {
    await page.goto('/repositories');
    await page.getByLabel('Path or GitHub URL').fill('https://github.com/acme/e2e58-new');
    await branchField(page).fill('relase');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.waitForURL(/registration=/);
    const jobId = new URL(page.url()).searchParams.get('registration') as string;
    expect(
      await withDatabase(
        (db) =>
          (db.prepare('select payload from jobs where id = ?').get(jobId) as { payload: string })
            .payload,
      ),
    ).toBe(JSON.stringify({ url: 'https://github.com/acme/e2e58-new', branch: 'relase' }));
    await expect(page.getByTestId('registration-status')).toContainText('Waiting for the runner');
    await expect(branchField(page)).toBeDisabled();
    await expect(branchField(page)).toHaveValue('relase');

    const message =
      'The branch relase does not exist in acme/e2e58-new. Check the name on GitHub, or leave Branch empty to use the default branch.';
    await finish(jobId, { ok: false, code: 'branch-not-found', message });
    await expect(page.getByTestId('branch-error')).toHaveText(message, { timeout: RUNNER_TIMEOUT });
    await expect(page.getByTestId('path-error')).toHaveCount(0);
    await expect(branchField(page)).toHaveValue('relase');
    await expect(branchField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue(
      'https://github.com/acme/e2e58-new',
    );
  });

  test('Change branch works with the keyboard only: open, invalid name, cancel', async ({
    page,
  }) => {
    await page.goto('/repositories');
    const open = page.getByRole('button', {
      name: `Change branch of ${subject('acme/e2e58-rules')}`,
    });
    for (let i = 0; i < 120 && !(await open.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(open).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('branch-panel')).toContainText(
      `Branch of ${subject('acme/e2e58-rules')}`,
    );
    await expect(panelField(page)).toBeFocused();
    await expect(panelField(page)).toHaveValue('release/2.0');
    await expect(panelField(page)).not.toHaveAttribute('placeholder');
    await expect(page.getByTestId('branch-panel')).toContainText(
      'Saving does not scan. The next scan reads the new branch: artifacts found only on release/2.0 are then marked missing',
    );
    await expect(panelField(page)).toHaveAccessibleDescription(
      'Leave empty to follow the default branch (main).',
    );

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('release 2.0');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('change-branch-error')).toHaveText(BRANCH_RULE);
    await expect(panelField(page)).toBeFocused();
    await expect(panelField(page)).toHaveValue('release 2.0');
    await expect(panelField(page)).toHaveAttribute('aria-invalid', 'true');

    await page.keyboard.press('Tab'); // Save branch
    await page.keyboard.press('Tab'); // Cancel
    await expect(page.getByRole('link', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('branch-panel')).toHaveCount(0);
    expect(
      await withDatabase((db) =>
        count(db, "select count(*) as n from jobs where type = 'repository-branch'"),
      ),
    ).toBe(0);
  });

  test('Change sits in the Branch cell, Scan and Remove stay on one line, and Cancel returns to Change (issue 249)', async ({
    page,
  }) => {
    // 1280px inside the app shell: the content is 72rem minus the sidebar (issue 122).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/repositories');
    for (const [, name] of REPOS) {
      const cells = row(page, name).getByRole('cell');
      const change = cells.nth(3).getByRole('button', {
        name: `Change branch of ${subject(name)}`,
        exact: true,
      });
      await expect(change).toHaveText('Change');
      await expect(change).toHaveAttribute('data-size', 'xs');
      await expect(change).toHaveCSS('cursor', 'pointer');
      const actions = cells.nth(6).getByRole('button');
      await expect(actions).toHaveText(['Scan', 'Remove']);
      const [scan, remove] = await Promise.all([
        actions.nth(0).boundingBox(),
        actions.nth(1).boundingBox(),
      ]);
      expect(scan?.y, `${name}: Scan and Remove on one line`).toBe(remove?.y);
    }

    // Keyboard only: Change opens the panel with the Branch field focused; Cancel goes back.
    const open = row(page, 'acme/e2e58-prompts')
      .getByRole('cell')
      .nth(3)
      .getByRole('button', { name: `Change branch of ${subject('acme/e2e58-prompts')}` });
    for (let i = 0; i < 120 && !(await open.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(open).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('branch-panel')).toContainText(
      `Branch of ${subject('acme/e2e58-prompts')}`,
    );
    await expect(panelField(page)).toBeFocused();
    await page.keyboard.press('Tab'); // Save branch
    await page.keyboard.press('Tab'); // Cancel
    await expect(page.getByRole('link', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('branch-panel')).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(open).toBeInViewport();
    // The next Tab continues from Change to the row's Scan.
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: `Scan ${subject('acme/e2e58-prompts')}` }),
    ).toBeFocused();
  });

  test('saving enqueues a branch change; the panel waits, then says what changed', async ({
    page,
  }) => {
    await page.goto('/repositories');
    await page
      .getByRole('button', { name: `Change branch of ${subject('acme/e2e58-rules')}` })
      .click();
    await panelField(page).fill('release/3.0');
    await page.getByRole('button', { name: 'Save branch' }).click();
    await page.waitForURL(/branchChange=/);
    const jobId = new URL(page.url()).searchParams.get('branchChange') as string;
    await expect(page.getByTestId('branch-status')).toContainText('Waiting for the runner');
    await expect(panelField(page)).toBeDisabled();

    // The remote does not have it: the error goes under the field and the value stays.
    const missing =
      'The branch release/3.0 does not exist in acme/e2e58-rules. Nothing was changed: the repository still uses release/2.0.';
    await finish(jobId, { ok: false, code: 'branch-not-found', message: missing });
    await expect(page.getByTestId('change-branch-error')).toHaveText(missing, {
      timeout: RUNNER_TIMEOUT,
    });
    await expect(panelField(page)).toHaveValue('release/3.0');
    await expect(panelField(page)).toBeEnabled();

    // A name that exists: the runner stores it, the page says so and does not scan.
    await panelField(page).fill('release/2.1');
    await page.getByRole('button', { name: 'Save branch' }).click();
    await page.waitForURL((url) => url.searchParams.get('branchChange') !== jobId);
    const second = new URL(page.url()).searchParams.get('branchChange') as string;
    await withDatabase((db) =>
      db
        .prepare(
          "update repositories set selected_branch = 'release/2.1' where id = 'repo_e2e58_b'",
        )
        .run(),
    );
    await finish(second, { ok: true, branch: 'release/2.1', defaultBranch: 'main' });
    await expect(page.getByTestId('branch-result')).toHaveText(
      'acme/e2e58-rules now uses the branch release/2.1. Scan it to read that branch.',
      { timeout: RUNNER_TIMEOUT },
    );
    await expect(page.getByTestId('branch-panel')).toHaveCount(0);
    await expect(row(page, 'acme/e2e58-rules').getByRole('cell').nth(5)).toContainText(
      'That scan read main: scan again to read release/2.1.',
    );
    expect(
      await withDatabase((db) =>
        count(
          db,
          "select count(*) as n from jobs where type = 'repository-scan' and payload like '%repo_e2e58_b%'",
        ),
      ),
    ).toBe(0);
  });

  test('a change is refused while a scan or another change of the repository waits', async ({
    page,
  }) => {
    await withDatabase((db) =>
      db
        .prepare(
          `insert into jobs (id, type, status, payload, attempts, created_at) values ('job_e2e58_scan', 'repository-scan', 'running', ?, 1, ?)`,
        )
        .run(JSON.stringify({ repositoryId: 'repo_e2e58_a' }), new Date().toISOString()),
    );
    try {
      await page.goto('/repositories?changeBranch=repo_e2e58_a');
      await panelField(page).fill('dev');
      await page.getByRole('button', { name: 'Save branch' }).click();
      await expect(page.getByTestId('branch-result')).toHaveText(
        'A scan of this repository is waiting or running. Change its branch after the scan finishes.',
      );
      await expect(page.getByTestId('branch-result')).toHaveAttribute('role', 'alert');
    } finally {
      await withDatabase((db) =>
        db.exec(
          "update jobs set status = 'cancelled', finished_at = 't' where id = 'job_e2e58_scan'",
        ),
      );
    }
    await page.goto('/repositories?changeBranch=repo_e2e58_c');
    await panelField(page).fill('trunk');
    await page.getByRole('button', { name: 'Save branch' }).click();
    await page.waitForURL(/branchChange=/);
    await page.goto('/repositories?changeBranch=repo_e2e58_c');
    await panelField(page).fill('other');
    await page.getByRole('button', { name: 'Save branch' }).click();
    await expect(page.getByTestId('branch-result')).toHaveText(
      'Another branch change of this repository is waiting or running. Try again after it finishes.',
    );
    // A panel for a repository that is not hosted or not registered says so instead.
    await page.goto('/repositories?changeBranch=repo_e2e58_missing');
    await expect(page.getByTestId('branch-result')).toHaveText(
      'That repository no longer exists. It may have been removed; reload the list.',
    );
  });

  test('the branch states meet contrast in both themes and fit 320px', async ({ page }) => {
    const states = [
      '/repositories?changeBranch=repo_e2e58_b&branchName=a+b&branchError=invalid',
      '/repositories?path=https%3A%2F%2Fgithub.com%2Facme%2Fx&branchName=a+b&branchError=invalid',
    ];
    for (const state of states) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(state);
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
        expect(failures, `${state} ${theme}`).toEqual([]);
      }
      await page.setViewportSize({ width: 320, height: 800 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    }
  });
});
