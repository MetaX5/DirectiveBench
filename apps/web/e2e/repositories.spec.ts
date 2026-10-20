import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { count, withDatabase } from './support';

/** The runner polls every second; leave room for a slow CI host. */
const REGISTRATION_TIMEOUT = 30_000;

// The runner resolves symlinks (e.g. macOS /var → /private/var), so compare with the real path.
const sources = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-e2e-sources-')));
const repo = join(sources, 'team-skills');
const plain = join(sources, 'plain-rules');
const project = join(sources, 'scan-me');
const outside = join(sources, 'outside');
const removed = join(sources, 'removed-meanwhile');

function write(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
}

test.beforeAll(() => {
  mkdirSync(join(repo, 'skills', 'review'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  mkdirSync(plain);
  mkdirSync(removed);
  writeFileSync(join(sources, 'notes.txt'), 'not a directory\n');
  // A repository with every format of SPEC-013 M1 AC1 and a symlink at a candidate path.
  write(project, {
    '.agents/skills/e2e-review/SKILL.md':
      '---\nname: e2e-review\ndescription: Review pull requests.\n---\n# Review\n',
    '.agents/skills/e2e-review/references/checklist.md': '# Checklist\n',
    'AGENTS.md': '# Repository rules\n',
    '.cursor/rules/react.mdc': '---\nglobs: "src/**/*.tsx"\n---\n# React\n',
    '.github/copilot-instructions.md': '# Copilot\n',
    'node_modules/pkg/SKILL.md': '---\nname: hidden\n---\n',
  });
  write(outside, { 'CLAUDE.md': '# Outside\n' });
  symlinkSync(join(outside, 'CLAUDE.md'), join(project, 'CLAUDE.md'));
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
      'Last scan',
      'Actions',
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
    await expect(row.getByRole('cell')).toHaveText([
      'team-skills',
      'Local Git',
      repo,
      'main',
      '0',
      'Never',
      'Scan',
    ]);
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
      'Never',
      'Scan',
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

  test('scanning a repository discovers its artifacts and reports discovery errors', async ({
    page,
  }) => {
    await register(page, project);
    await expect(page.getByTestId('registration-status')).toHaveText(
      `Registered scan-me (Local directory, ${project}).`,
      { timeout: REGISTRATION_TIMEOUT },
    );
    await expect(page.getByTestId('scan-explanation')).toContainText('working tree');

    await page.getByRole('button', { name: 'Scan scan-me' }).click();
    await expect(page.getByTestId('scan-status')).toHaveText(
      /^Scanned scan-me: \d+ files in [\d.]+ (ms|s), 4 artifacts found \(4 new, 4 new versions\), 1 error\.$/,
      { timeout: REGISTRATION_TIMEOUT },
    );
    await expect(page.getByTestId('scan-errors')).toContainText(
      'CLAUDE.md symlink CLAUDE.md is a symbolic link and is not followed',
    );
    const row = repositoryRow(page, project);
    await expect(row.getByRole('cell').nth(4)).toHaveText('4');
    await expect(row.getByRole('cell').nth(5)).not.toHaveText('Never');

    const occurrences = await withDatabase((db) =>
      db
        .prepare(
          `select o.path, a.type, v.format from artifact_occurrences o
             join artifacts a on a.id = o.artifact_id
             join artifact_versions v on v.id = o.latest_version_id
             join repositories r on r.id = o.repository_id
            where r.location = ? order by o.path`,
        )
        .all(project),
    );
    expect(occurrences).toEqual([
      { path: '.agents/skills/e2e-review', type: 'skill', format: 'skill-md' },
      { path: '.cursor/rules/react.mdc', type: 'rule', format: 'cursor-rule' },
      {
        path: '.github/copilot-instructions.md',
        type: 'instruction',
        format: 'copilot-instructions',
      },
      { path: 'AGENTS.md', type: 'instruction', format: 'agents-md' },
    ]);

    // A rescan of the unchanged tree creates nothing new.
    await page.getByRole('button', { name: 'Scan scan-me' }).click();
    await expect(page.getByTestId('scan-status')).toContainText(
      '4 artifacts found (0 new, 0 new versions)',
      { timeout: REGISTRATION_TIMEOUT },
    );

    await page.goto('/artifacts');
    await expect(page.getByRole('link', { name: 'e2e-review' })).toBeVisible();
  });

  test('scanning a repository removed meanwhile returns to the page with an error', async ({
    page,
  }) => {
    await register(page, removed);
    await expect(page.getByTestId('registration-status')).toContainText('Registered ', {
      timeout: REGISTRATION_TIMEOUT,
    });
    // Removed after the page rendered its Scan button (no removal UI exists yet).
    await withDatabase((db) =>
      db.prepare('delete from repositories where location = ?').run(removed),
    );
    await page.getByRole('button', { name: 'Scan removed-meanwhile' }).click();
    await expect(page.getByTestId('scan-request-error')).toHaveText(
      'That repository no longer exists. It may have been removed; reload the list.',
    );
    await expect(page).toHaveURL(/\/repositories\?scanError=not-found$/);
    await expect(repositoryRow(page, removed)).toHaveCount(0);
  });

  test('the filesystem root is rejected (FR-104-18)', async ({ page }) => {
    await register(page, '/');
    await expect(page.getByTestId('path-error')).toHaveText(
      'The filesystem root cannot be registered: a scan would read the whole disk. Register a project directory instead.',
      { timeout: REGISTRATION_TIMEOUT },
    );
    expect(await rowsAt('/')).toBe(0);
  });

  test('a path containing registered repositories needs a confirmation (FR-104-18)', async ({
    page,
  }) => {
    await register(page, sources);
    const confirmation = page.getByTestId('registration-confirmation');
    await expect(confirmation).toContainText(`Register ${sources} anyway?`, {
      timeout: REGISTRATION_TIMEOUT,
    });
    await expect(confirmation).toContainText(
      `It contains the registered repository team-skills (${repo}). A scan reads that repository's files again and counts each of its artifacts twice, once per repository.`,
    );
    await expect(confirmation.getByRole('listitem')).toHaveCount(3);

    await confirmation.getByRole('link', { name: 'Cancel' }).click();
    await expect(page.getByTestId('registration-confirmation')).toHaveCount(0);
    expect(await rowsAt(sources)).toBe(0);

    await register(page, sources);
    await page
      .getByTestId('registration-confirmation')
      .getByRole('button', { name: 'Register anyway' })
      .click();
    await expect(page.getByTestId('registration-status')).toContainText(`Registered `, {
      timeout: REGISTRATION_TIMEOUT,
    });
    expect(await rowsAt(sources)).toBe(1);
  });

  test('the home directory needs a confirmation that says user-level folders are skipped (D05)', async ({
    page,
  }) => {
    const before = await withDatabase((db) => count(db, 'select count(*) as n from repositories'));
    await register(page, '~');
    const confirmation = page.getByTestId('registration-confirmation');
    await expect(confirmation).toContainText('This is your home directory.', {
      timeout: REGISTRATION_TIMEOUT,
    });
    await expect(confirmation).toContainText(
      'User-level agent folders such as ~/.claude, ~/.codex, ~/.cursor and ~/.agents are always skipped.',
    );
    await expect(confirmation).not.toContainText('~/.claude/skills');
    await confirmation.getByRole('link', { name: 'Cancel' }).click();
    expect(await withDatabase((db) => count(db, 'select count(*) as n from repositories'))).toBe(
      before,
    );
  });
});

// Public GitHub repositories by URL (issue #18). The suite never reaches the network: it tests
// the web-side validation, and shows runner outcomes it seeds into the database itself. The
// runner's git side is covered against a local bare repository in packages/runner.
test.describe('GitHub repositories by URL', () => {
  const token = 'ghp_e2eTokenAbcdefghijklmnopqrstu';

  test('a URL with credentials is rejected with an explanation and appears nowhere', async ({
    page,
  }) => {
    const jobsBefore = await withDatabase((db) => count(db, 'select count(*) as n from jobs'));
    await register(page, `https://e2e-user:${token}@github.com/acme/private-skills`);

    await expect(page.getByTestId('path-error')).toHaveText(
      'The URL contains credentials (a user name, password or token). Remove them and enter https://github.com/<owner>/<repo>: DirectiveBench reads public GitHub repositories without credentials and never stores them.',
    );
    expect(page.url()).not.toContain(token);
    expect(page.url()).not.toContain('e2e-user');
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue('');
    expect(await page.content()).not.toContain(token);
    await withDatabase((db) => {
      expect(count(db, 'select count(*) as n from jobs')).toBe(jobsBefore);
      expect(
        count(db, "select count(*) as n from jobs where payload like '%' || ? || '%'", token),
      ).toBe(0);
      expect(
        count(db, "select count(*) as n from repositories where location like '%e2e-user%'"),
      ).toBe(0);
    });
  });

  test('a malformed URL with a token is rejected without echoing it anywhere', async ({ page }) => {
    // Not recognised as a URL, so it is rejected by path validation (Codex review round 2).
    const jobsBefore = await withDatabase((db) => count(db, 'select count(*) as n from jobs'));
    await register(page, `https:/github.com/acme/skills?access_token=${token}`);

    await expect(page.getByTestId('path-error')).toContainText(
      'It is not shown again because it contains @, ? or #, which can carry credentials.',
    );
    expect(page.url()).toContain('urlError=not-echoed');
    expect(page.url()).not.toContain(token);
    expect(page.url()).not.toContain('access_token');
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue('');
    expect(await page.content()).not.toContain(token);
    await withDatabase((db) => {
      expect(count(db, 'select count(*) as n from jobs')).toBe(jobsBefore);
    });

    // A hand-made `?path=` with a token shows the error but is not put back into the field.
    await page.goto(`/repositories?path=${encodeURIComponent(`code/x?token=${token}`)}`);
    await expect(page.getByTestId('path-error')).toContainText('Enter an absolute path');
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue('');
  });

  test('an unsupported URL returns to the form with the reason', async ({ page }) => {
    await register(page, 'https://gitlab.com/acme/skills');

    await expect(page.getByTestId('path-error')).toContainText(
      'Only public repositories on github.com can be registered by URL so far.',
    );
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue(
      'https://gitlab.com/acme/skills',
    );
    await expect(page.getByLabel('Path or GitHub URL')).toHaveAttribute('aria-invalid', 'true');
  });

  test('a registered GitHub repository is listed with its branch and can be scanned', async ({
    page,
  }) => {
    const location = 'https://github.com/acme/e2e-skills';
    const repositoryId = 'repo_e2e_github';
    const jobId = 'job_e2e_github_registration';
    const now = new Date().toISOString();
    await withDatabase((db) => {
      db.prepare(
        `insert into repositories (id, provider, name, location, default_branch, sync_status, created_at, updated_at)
         values (?, 'github', 'acme/e2e-skills', ?, 'main', 'never', ?, ?)`,
      ).run(repositoryId, location, now, now);
      db.prepare(
        `insert into jobs (id, type, status, payload, result, attempts, created_at, finished_at)
         values (?, 'repository-registration', 'completed', ?, ?, 1, ?, ?)`,
      ).run(
        jobId,
        JSON.stringify({ url: location }),
        JSON.stringify({ ok: true, repositoryId, created: true }),
        now,
        now,
      );
    });

    await page.goto(`/repositories?registration=${jobId}`);
    await expect(page.getByTestId('registration-status')).toHaveText(
      `Registered acme/e2e-skills (GitHub, ${location}).`,
    );
    const row = repositoryRow(page, location);
    await expect(row.getByRole('cell')).toHaveText([
      'acme/e2e-skills',
      'GitHub',
      location,
      'main',
      '0',
      'Never',
      'Scan',
    ]);
    // Not clicked: a scan would reach github.com, and the suite stays offline.
    await expect(row.getByRole('button', { name: 'Scan acme/e2e-skills' })).toBeEnabled();
  });

  test('a repository that is not public shows "not found or not public" and keeps the URL', async ({
    page,
  }) => {
    const jobId = 'job_e2e_github_not_found';
    const now = new Date().toISOString();
    await withDatabase((db) => {
      db.prepare(
        `insert into jobs (id, type, status, payload, result, attempts, created_at, finished_at)
         values (?, 'repository-registration', 'completed', ?, ?, 1, ?, ?)`,
      ).run(
        jobId,
        JSON.stringify({ url: 'https://github.com/acme/private-skills' }),
        JSON.stringify({
          ok: false,
          code: 'auth-required',
          message:
            'The repository was not found or is not public. DirectiveBench reads public GitHub repositories without credentials; private repositories are not supported yet.',
        }),
        now,
        now,
      );
    });

    await page.goto(`/repositories?registration=${jobId}`);
    await expect(page.getByTestId('path-error')).toContainText(
      'The repository was not found or is not public.',
    );
    await expect(page.getByLabel('Path or GitHub URL')).toHaveValue(
      'https://github.com/acme/private-skills',
    );
  });
});
