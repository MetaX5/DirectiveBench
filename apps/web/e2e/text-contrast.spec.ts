import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '../components/ui/badge';
import { scanTextContrast } from './contrast';

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
