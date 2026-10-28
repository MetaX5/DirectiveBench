import { expect, test } from '@playwright/test';
import {
  DEMO_ARTIFACT,
  DEMO_SUITE,
  MOCK_LABEL,
  count,
  escapeRegExp,
  withDatabase,
} from './support';

// Pin the OS colour scheme so the initial theme (which follows `prefers-color-scheme`) is known.
test.use({ colorScheme: 'light' });

/** Sidebar entries in the order required by SPEC-116 FR-116-01, with their page headings. */
const NAV = [
  { label: 'Dashboard', path: '/', heading: 'Dashboard' },
  { label: 'Repositories', path: '/repositories', heading: 'Repositories' },
  { label: 'Artifacts', path: '/artifacts', heading: 'Artifacts' },
  { label: 'Categories', path: '/categories', heading: 'Categories' },
  { label: 'Benchmarks', path: '/benchmarks', heading: 'Benchmarks' },
  { label: 'Benchmark Builder', path: '/builder', heading: 'Benchmark Builder', planned: true },
  { label: 'Executions', path: '/executions', heading: 'Executions' },
  { label: 'Results', path: '/results', heading: 'Results' },
  { label: 'Agent Connections', path: '/agents', heading: 'Agent Connections' },
  { label: 'Model Providers', path: '/providers', heading: 'Model Providers', planned: true },
  { label: 'Settings', path: '/settings', heading: 'Settings' },
] as const;

function linkName(item: (typeof NAV)[number]): RegExp {
  return new RegExp(
    `^${escapeRegExp(item.label)}${'planned' in item ? String.raw`\s*planned` : ''}$`,
  );
}

test('dashboard shows registry counts that match the database and the persisted demo run', async ({
  page,
}) => {
  const expected = await withDatabase((db) => ({
    repositories: count(db, 'select count(*) as n from repositories'),
    artifacts: count(db, 'select count(*) as n from artifacts'),
    skills: count(db, "select count(*) as n from artifacts where type = 'skill'"),
    rulesAndInstructions: count(
      db,
      "select count(*) as n from artifacts where type in ('rule', 'instruction')",
    ),
    runs: count(db, 'select count(*) as n from benchmark_runs'),
  }));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // The demo seeds exactly one skill; the tiles must equal the SQL counts (no sample data).
  await expect(page.getByTestId('stat-artifacts')).toHaveText('1');
  await expect(page.getByTestId('stat-skills')).toHaveText('1');
  await expect(page.getByTestId('stat-artifacts')).toHaveText(String(expected.artifacts));
  await expect(page.getByTestId('stat-skills')).toHaveText(String(expected.skills));
  await expect(page.getByTestId('stat-rules-instructions')).toHaveText(
    String(expected.rulesAndInstructions),
  );
  await expect(page.getByTestId('stat-repositories')).toHaveText(String(expected.repositories));
  await expect(page.getByTestId('stat-benchmark-runs')).toHaveText(String(expected.runs));
  await expect(page.getByTestId('stat-last-synchronisation')).toHaveText('Never');
  await expect(page.getByText('Repository sync is planned (Milestone 2)')).toBeVisible();

  // Recent runs list the demo run with the mock label, and no regression is invented.
  const recent = page.getByRole('row', { name: new RegExp(DEMO_ARTIFACT) }).first();
  await expect(recent).toContainText(DEMO_SUITE);
  await expect(recent).toContainText(MOCK_LABEL);
  await expect(recent.locator('[data-status]')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();
  await expect(page.getByText('No regressions among the recent runs.')).toBeVisible();
});

test('dashboard links a recent run to its result detail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_ARTIFACT }).first().click();
  await expect(page).toHaveURL(/\/results\/run_[\w-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(DEMO_ARTIFACT);
  await expect(page.getByTestId('verdict')).toHaveText('improved');
});

test('sidebar lists every section in order and marks planned ones', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('aside').getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText(NAV.map(linkName));
  for (const item of NAV) {
    await expect(nav.getByRole('link', { name: linkName(item) })).toHaveAttribute(
      'href',
      item.path,
    );
  }
});

test('navigation reaches every section and marks the active item', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('aside').getByRole('navigation', { name: 'Main' });
  // Visit in reverse so that every click is a client-side navigation away from another section.
  for (const item of [...NAV].reverse()) {
    const link = nav.getByRole('link', { name: linkName(item) });
    await link.click();
    await expect(page).toHaveURL(new URL(item.path, page.url()).href);
    await expect(page.getByRole('heading', { level: 1, name: item.heading })).toBeVisible();
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    if ('planned' in item) {
      await expect(page.getByText('Planned: not implemented')).toBeVisible();
      await expect(
        page
          .getByRole('main')
          .getByText(/\.ai\/specs\/[\w-]+\.md/)
          .first(),
      ).toBeVisible();
      await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
    }
  }
});

test('planned sections are labelled as not implemented', async ({ page }) => {
  await page.goto('/builder');
  await expect(page.getByText('Planned: not implemented')).toBeVisible();
  await expect(page.getByText('.ai/specs/2026-10-14-benchmark-builder.md')).toBeVisible();
});

test('unknown routes show the not-found page with a way back', async ({ page }) => {
  await page.goto('/artifacts/does-not-exist');
  await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
});

test('theme toggle switches between light and dark and persists across reloads', async ({
  page,
}) => {
  await page.goto('/');
  const html = page.locator('html');
  const toggle = page.getByRole('button', { name: 'Toggle colour theme' }).first();
  await expect(html).toHaveClass(/\blight\b/);
  // A click before hydration has no handler yet; retry until the theme actually switches.
  await expect(async () => {
    await toggle.click();
    await expect(html).toHaveClass(/\bdark\b/, { timeout: 1_000 });
  }).toPass();
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(async () => {
    await toggle.click();
    await expect(html).toHaveClass(/\blight\b/, { timeout: 1_000 });
  }).toPass();
});
