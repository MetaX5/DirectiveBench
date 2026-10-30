import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { e2eTmpRoot } from './support';

/**
 * Issue #17 (E01-S03, SPEC-101): artifacts of two registered repositories in one list, filters in
 * the URL, the detail Overview and Content tabs, and inert rendering of untrusted content
 * (FR-101-18). The fixtures are registered and scanned through the UI, as a user would.
 */

/** The runner polls every second; leave room for a slow CI host. */
const RUNNER_TIMEOUT = 30_000;

const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'registry-')));
const team = join(sources, 'registry-team');
const client = join(sources, 'registry-client');
const skillDir = '.agents/skills/e2e-safe-preview';

const MALICIOUS_SKILL = [
  '---',
  'name: e2e-safe-preview',
  'description: Previews content safely.',
  '---',
  '# Safe preview',
  '',
  '<script>window.__pwned = "script"</script>',
  '<img src="x" onerror="window.__pwned = \'img\'">',
  '',
  'A [bad link](javascript:window.__pwned=1) and a [good link](https://example.com/docs).',
  'Also [a relative link](references/guide.md) and ![a tracking pixel](https://example.com/p.png).',
  '',
  '```sh',
  'echo "<b>not bold</b>"',
  '```',
  '',
  '| Tool | Scope | Notes |',
  '| --- | --- | --- |',
  '| lint | repo | fast |',
  '| short |',
  '',
].join('\n');

/** Leading blank line, tabs, trailing spaces, non-ASCII text and no final newline. */
const TRICKY_AGENTS =
  '\n# Team rules\n\n\t- indented with a tab  \nZażółć gęślą jaźń — ✓ <b>raw</b>';

const files: Record<string, Record<string, string>> = {
  [team]: {
    [`${skillDir}/SKILL.md`]: MALICIOUS_SKILL,
    [`${skillDir}/references/guide.md`]: '# Guide\n\nRead me.\n',
    [`${skillDir}/scripts/setup.sh`]: '#!/bin/sh\necho "<script>alert(1)</script>" > /tmp/pwned\n',
    'AGENTS.md': TRICKY_AGENTS,
  },
  [client]: {
    'AGENTS.md': '# Client rules\n',
    '.cursor/rules/e2e-style.mdc': '---\nglobs: "src/**/*.ts"\n---\n# Style\n',
  },
};

test.beforeAll(() => {
  for (const [root, tree] of Object.entries(files)) {
    for (const [relPath, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, relPath)), { recursive: true });
      writeFileSync(join(root, relPath), content);
    }
  }
});

test.afterAll(() => rmSync(sources, { recursive: true, force: true }));

async function registerAndScan(page: Page, path: string, name: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByLabel('Path').fill(path);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByTestId('registration-status')).toHaveText(
    `Registered ${name} (Local directory, ${path}).`,
    { timeout: RUNNER_TIMEOUT },
  );
  await page.getByRole('button', { name: `Scan ${name}` }).click();
  await expect(page.getByTestId('scan-status')).toContainText(`Scanned ${name}:`, {
    timeout: RUNNER_TIMEOUT,
  });
}

function artifactRow(page: Page, name: string, repository: string) {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name, exact: true }) })
    .filter({ hasText: repository });
}

/** The raw view's text exactly as the DOM holds it. */
async function rawText(page: Page): Promise<string> {
  return page.getByTestId('artifact-raw').evaluate((element) => element.textContent ?? '');
}

test.describe.serial('artifact registry', () => {
  test('lists the artifacts of two repositories with type, repository and occurrences', async ({
    page,
  }) => {
    await registerAndScan(page, team, 'registry-team');
    await registerAndScan(page, client, 'registry-client');

    await page.goto('/artifacts');
    const skill = artifactRow(page, 'e2e-safe-preview', 'registry-team');
    await expect(skill.getByRole('cell').nth(1)).toHaveText('skill');
    await expect(skill.getByRole('cell').nth(4)).toHaveText('registry-team');
    await expect(skill.getByRole('cell').nth(5)).toHaveText('1');
    // Never evaluated: no score and no mock label (FR-101-14 labels only mock results).
    await expect(skill.getByTestId('latest-score')).toHaveText('—');
    // Same-named instructions from two repositories stay two artifacts (SPEC-101 §8.3).
    for (const repository of ['registry-team', 'registry-client']) {
      const row = artifactRow(page, 'AGENTS.md', repository);
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('cell').nth(1)).toHaveText('instruction');
      await expect(row.getByRole('cell').nth(5)).toHaveText('1');
    }
    await expect(
      artifactRow(page, 'e2e-style', 'registry-client').getByRole('cell').nth(1),
    ).toHaveText('rule');
  });

  test('filters by repository, type and category, reflected in the URL', async ({ page }) => {
    await page.goto('/artifacts');
    await page.locator('select[name="repository"]').selectOption({ label: 'registry-client' });
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/[?&]repository=repo_[\w-]+/);
    const links = page.getByRole('row').getByRole('link', { name: /./ });
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(links.filter({ hasText: 'AGENTS.md' })).toHaveCount(1);
    await expect(links.filter({ hasText: 'e2e-style' })).toHaveCount(1);

    await page.locator('select[name="type"]').selectOption('rule');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/[?&]type=rule/);
    await expect(page).toHaveURL(/[?&]repository=repo_/);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'e2e-style' })).toBeVisible();

    // Reloading keeps the filters; the selects show them.
    await page.reload();
    await expect(page.locator('select[name="type"]')).toHaveValue('rule');
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // Categories come from the existing category data (assignment is issue #22).
    await page.goto('/artifacts');
    await page.locator('select[name="category"]').selectOption('security');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/[?&]category=security/);
    await expect(page.getByRole('link', { name: 'e2e-safe-preview' })).toHaveCount(0);

    // An invalid value is ignored with a visible notice instead of failing the page.
    await page.goto('/artifacts?type=script&repository=nope');
    await expect(page.getByTestId('filter-notice')).toHaveText(
      'Ignored invalid values in the URL: type, repository.',
    );
    await expect(page.getByRole('link', { name: 'e2e-safe-preview' })).toBeVisible();
    await page.getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/artifacts$/);
  });

  test('the Overview lists occurrences and the Content tab shows rendered and raw content', async ({
    page,
  }) => {
    await page.goto('/artifacts');
    await artifactRow(page, 'e2e-safe-preview', 'registry-team')
      .getByRole('link', { name: 'e2e-safe-preview' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'e2e-safe-preview' })).toBeVisible();
    const occurrence = page.getByTestId('occurrences').getByRole('row').nth(1);
    await expect(occurrence.getByRole('cell')).toHaveText([
      'registry-team',
      'Local directory',
      skillDir,
      'active',
      /UTC$/,
    ]);

    await page
      .getByRole('navigation', { name: 'Artifact sections' })
      .getByRole('link', { name: 'Content' })
      .click();
    const tree = page.getByTestId('file-tree');
    await expect(tree).toContainText('references/');
    await expect(tree).toContainText('scripts/');
    await expect(tree.getByRole('link')).toHaveText(['guide.md', 'setup.sh', 'SKILL.md']);
    await expect(tree.getByRole('link', { name: 'SKILL.md' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Raw view: byte for byte the source file (SPEC-013 M1, D01).
    const source = readFileSync(join(team, skillDir, 'SKILL.md'));
    expect(Buffer.from(await rawText(page), 'utf8').equals(source)).toBe(true);

    // Rendered view: Markdown, with raw HTML as text and no active content (FR-101-18).
    const rendered = page.getByTestId('artifact-rendered');
    await expect(rendered.getByRole('heading', { name: 'Safe preview' })).toBeVisible();
    await expect(rendered).toContainText('<script>window.__pwned = "script"</script>');
    await expect(rendered).toContainText('echo "<b>not bold</b>"');
    await expect(rendered.locator('script, img, iframe, b')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
    await expect(rendered.locator('[data-inert-link]')).toHaveText(['bad link', 'a relative link']);
    await expect(rendered.locator('[data-inert-image]')).toHaveText('[image: a tracking pixel]');
    await expect(rendered.getByRole('link', { name: 'good link' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    );
    await expect(rendered.getByRole('link', { name: 'good link' })).toHaveAttribute(
      'rel',
      'noopener noreferrer nofollow',
    );
    // A short GFM row keeps the header's width with one cell spanning the missing columns (#56).
    const tableRows = rendered.getByRole('table').getByRole('row');
    await expect(tableRows).toHaveCount(3);
    await expect(tableRows.nth(1).getByRole('cell')).toHaveText(['lint', 'repo', 'fast']);
    await expect(tableRows.nth(2).getByRole('cell')).toHaveText(['short', '']);
    await expect(tableRows.nth(2).getByRole('cell').nth(1)).toHaveAttribute('colspan', '2');
    await rendered.getByText('bad link').click();
    expect(await page.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();

    // A supporting script is shown as text only.
    await tree.getByRole('link', { name: 'setup.sh' }).click();
    await expect(page).toHaveURL(/[?&]file=.*setup\.sh/);
    await expect(page.getByTestId('content-path')).toHaveText(`scripts/setup.sh`);
    await expect(rendered).toContainText('This file is shown as text only');
    const script = readFileSync(join(team, skillDir, 'scripts', 'setup.sh'));
    expect(Buffer.from(await rawText(page), 'utf8').equals(script)).toBe(true);
    expect(await page.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();
  });

  test('the raw view keeps leading newlines, tabs, non-ASCII text and a missing final newline', async ({
    page,
  }) => {
    await page.goto('/artifacts');
    await artifactRow(page, 'AGENTS.md', 'registry-team')
      .getByRole('link', { name: 'AGENTS.md' })
      .click();
    await page
      .getByRole('navigation', { name: 'Artifact sections' })
      .getByRole('link', { name: 'Content' })
      .click();
    const source = readFileSync(join(team, 'AGENTS.md'));
    expect(Buffer.from(await rawText(page), 'utf8').equals(source)).toBe(true);
    await expect(
      page.getByTestId('artifact-rendered').getByRole('heading', { name: 'Team rules' }),
    ).toBeVisible();

    // Unknown versions and files fall back to the latest version's primary file, with a notice.
    await page.goto(`${page.url().split('?')[0]}?tab=content&version=99&file=nope.md`);
    await expect(page.getByTestId('artifact-notice')).toContainText(
      'Version 99 does not exist; showing the latest version.',
    );
    expect(Buffer.from(await rawText(page), 'utf8').equals(source)).toBe(true);
  });
});
