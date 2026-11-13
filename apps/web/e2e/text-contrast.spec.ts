import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '../components/ui/badge';
import { scanTextContrast } from './contrast';
import { DEMO_ARTIFACT, withDatabase } from './support';

/** Archives or unarchives a demo category for the scan (setup only; the pages are SPEC-124). */
async function setArchived(slug: string, archived: boolean): Promise<void> {
  await withDatabase((db) =>
    db
      .prepare('update categories set archived_at = ? where slug = ?')
      .run(archived ? new Date().toISOString() : null, slug),
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`visible text, placeholders and status surfaces have AA contrast in ${theme}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: theme });
    const paths = new Set([
      '/',
      '/repositories',
      '/artifacts',
      // The filter notice for a repository that is not registered (issue 216).
      '/artifacts?repository=repo_never',
      '/categories',
      '/benchmarks',
      '/builder',
      '/executions',
      '/results',
      '/agents',
      '/providers',
      '/settings',
      '/not-a-real-page',
    ]);
    const details = new Set<string>();
    const report = [];
    async function scan(path: string) {
      const rows = await scanTextContrast(page);
      const failures = rows.filter((row) => row.ratio < row.threshold);
      report.push({
        path,
        checked: rows.length,
        minimum: Math.min(...rows.map((row) => row.ratio)),
        failures,
      });
      expect.soft(failures, `${theme} ${path}`).toEqual([]);
    }
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await page.evaluate(() => document.fonts.ready);
      const links = await page
        .locator('main a[href^="/"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
      for (const href of links) {
        const group = href?.match(/^\/(artifacts|benchmarks|results)\/[^/?]+$/)?.[1];
        if (href && group && !details.has(group)) {
          paths.add(href);
          details.add(group);
        }
      }
      await scan(path);
    }
    // A category's page with the Archive panel open, then an archived category: the Archived
    // card, the header badge, the muted chips and the archived filter option (SPEC-124 §11.2).
    await page.goto('/categories/security');
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Archive Security' })).toBeVisible();
    await scan('/categories/security (Archive panel open)');
    const artifactId = await withDatabase(
      (db) =>
        (db.prepare('select id from artifacts where slug = ?').get(DEMO_ARTIFACT) as { id: string })
          .id,
    );
    await setArchived('code-quality', true);
    try {
      for (const path of [
        '/categories',
        '/categories/code-quality',
        '/artifacts?category=code-quality',
        `/artifacts/${artifactId}`,
      ]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await scan(`${path} (code-quality archived)`);
      }
    } finally {
      await setArchived('code-quality', false);
    }
    // A missing artifact (SPEC-125 §11.2 D11): the muted Missing Badge in the header and the list,
    // the note and the "missing" occurrence status. Nothing in the demo data is missing.
    await withDatabase((db) =>
      db
        .prepare(`update artifact_occurrences set status = 'removed' where artifact_id = ?`)
        .run(artifactId),
    );
    try {
      for (const path of [`/artifacts/${artifactId}`, '/artifacts']) {
        await page.goto(path);
        await expect(page.getByText('Missing', { exact: true }).first()).toBeVisible();
        await scan(`${path} (demo artifact missing)`);
      }
    } finally {
      await withDatabase((db) =>
        db
          .prepare(`update artifact_occurrences set status = 'active' where artifact_id = ?`)
          .run(artifactId),
      );
    }
    // The repository removal lines (SPEC-125 §11.3 D18, D26) through crafted URLs, which write
    // nothing: the green result, the alerts and the status line for an unknown panel target.
    for (const query of [
      'removedOccurrences=14&missingArtifacts=9',
      'removeError=not-found',
      'removeError=failed',
      'remove=repo_unknown',
    ]) {
      await page.goto(`/repositories?${query}`);
      await expect(page.getByTestId('remove-result')).toBeVisible();
      await scan(`/repositories?${query}`);
    }
    // Exercise every status variant and text role on actual app surface classes,
    // including regression-row and warning surfaces absent from an ordinary demo.
    await page.goto('/');
    const variants = [
      'default',
      'secondary',
      'outline',
      'success',
      'warning',
      'destructive',
      'info',
      'muted',
      'ghost',
      'link',
    ] as const;
    const textRoles = [
      'text-foreground',
      'text-muted-foreground',
      'text-success-foreground',
      'text-warning-foreground',
      'text-info-foreground',
      'text-destructive-foreground',
    ];
    const surfaces = [
      'bg-background',
      'bg-card',
      'bg-muted',
      'bg-accent',
      'bg-destructive/10',
      'bg-warning/10',
    ];
    const markup = surfaces
      .map((surface) =>
        renderToStaticMarkup(
          createElement(
            'div',
            { className: surface },
            ...variants.map((variant) =>
              createElement(Badge, { key: variant, variant, children: `${surface} ${variant}` }),
            ),
            ...textRoles.map((className) =>
              createElement('p', {
                key: className,
                className,
                children: `${surface} ${className}`,
              }),
            ),
          ),
        ),
      )
      .join('');
    await page.locator('main').evaluate((main, html) => {
      const fixture = document.createElement('div');
      fixture.innerHTML = html;
      main.appendChild(fixture);
    }, markup);
    const rows = await scanTextContrast(page);
    const failures = rows.filter((row) => row.ratio < row.threshold);
    report.push({
      path: 'semantic surface matrix',
      checked: rows.length,
      minimum: Math.min(...rows.map((row) => row.ratio)),
      failures,
    });
    expect.soft(failures, `${theme} semantic surface matrix`).toEqual([]);
    await testInfo.attach('text-contrast-report', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  });
}
