import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../components/ui/button';

test.use({ colorScheme: 'light' });

for (const theme of ['light', 'dark'] as const) {
  test(`buttons have readable text, pointer cursors and aligned form controls in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/repositories');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    const variants = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
    const markup = variants
      .map((variant) =>
        renderToStaticMarkup(
          createElement(Button, {
            variant,
            'aria-label': `Check ${variant}`,
            children: `Check ${variant}`,
          }),
        ),
      )
      .join('');
    await page.locator('main').evaluate((main, html) => {
      const fixture = document.createElement('div');
      fixture.id = 'button-contrast-checks';
      fixture.innerHTML = html;
      main.appendChild(fixture);
    }, markup);
    await page.addStyleTag({
      content: '#button-contrast-checks * { transition: none !important; }',
    });
    const ratios = [];
    for (const variant of variants) {
      const button = page.getByRole('button', { name: `Check ${variant}`, exact: true });
      for (const state of ['rest', 'hover', 'focus'] as const) {
        await page.mouse.move(0, 0);
        await button.evaluate((element) => element.blur());
        if (state === 'hover') await button.hover();
        if (state === 'focus') await button.focus();
        const ratio = await button.evaluate((element) => {
          const context = document.createElement('canvas').getContext('2d')!;
          context.fillStyle = 'white';
          context.fillRect(0, 0, 1, 1);
          const ancestors = [];
          for (
            let ancestor: Element | null = element;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            ancestors.unshift(ancestor);
          }
          for (const ancestor of ancestors) {
            context.fillStyle = getComputedStyle(ancestor).backgroundColor;
            context.fillRect(0, 0, 1, 1);
          }
          const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
          context.fillStyle = getComputedStyle(element).color;
          context.fillRect(0, 0, 1, 1);
          const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
          const luminance = (rgb: number[]) =>
            rgb.reduce((sum, value, index) => {
              const channel = value / 255;
              const linear =
                channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
            }, 0);
          const values = [luminance(background), luminance(foreground)];
          return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
        });
        ratios.push({ variant, state, ratio });
        expect.soft(ratio, `${theme} ${variant} ${state} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      await expect.soft(button).toHaveCSS('cursor', 'pointer', { timeout: 500 });
    }
    const input = page.getByRole('textbox', { name: 'Path or GitHub URL' });
    const register = page.getByRole('button', { name: 'Register', exact: true });
    expect.soft((await register.boundingBox())!.height).toBe((await input.boundingBox())!.height);
    await testInfo.attach('button-contrast-ratios', {
      body: JSON.stringify(ratios, null, 2),
      contentType: 'application/json',
    });
  });
}

test('preset components and local assets render in both themes', async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  const failedAssets: string[] = [];
  const loadedFonts: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(testInfo.project.use.baseURL!).origin) {
      externalRequests.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/_next/static/') && !response.ok()) {
      failedAssets.push(response.url());
    }
    if (response.request().resourceType() === 'font' && response.ok()) {
      loadedFonts.push(response.url());
    }
  });
  page.on('requestfailed', (request) => {
    // Next.js cancels navigation prefetches on reload; only assets are required here.
    if (request.url().includes('/_next/static/')) failedAssets.push(request.url());
  });

  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Toggle colour theme' }).first();
  await expect(toggle).toHaveAttribute('data-slot', 'button');
  await expect(page.locator('[data-slot="card"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="table"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="badge"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="table-cell"]').first()).toHaveCSS('white-space', 'normal');
  await expect(toggle).toHaveCSS('border-radius', '0px');
  await expect(page.locator('body')).toHaveCSS('font-family', /Figtree Variable/);
  // CSS optimization may serialize OKLCH as Lab; compare rendered sRGB pixels instead.
  const primaryColours = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!;
    const colours = [
      getComputedStyle(document.documentElement).getPropertyValue('--primary'),
      'oklch(0.841 0.238 128.85)',
    ];
    return colours.map((colour) => {
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
  });
  expect(primaryColours[0]).toEqual(primaryColours[1]);
  const lightBackground = await page
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.evaluate(() => document.fonts.ready);
  expect(loadedFonts.length).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      [...document.fonts].some(
        (face) => face.family.includes('Figtree') && face.status === 'loaded',
      ),
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard-light.png'), fullPage: true });

  await expect(async () => {
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/, { timeout: 1_000 });
  }).toPass();
  await expect(page.locator('body')).not.toHaveCSS('background-color', lightBackground);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('dashboard-dark.png'), fullPage: true });
  expect(externalRequests).toEqual([]);
  expect(failedAssets).toEqual([]);
});

test('preset native controls preserve artifact filtering and mobile navigation', async ({
  page,
}, testInfo) => {
  await page.goto('/artifacts');
  const search = page.getByRole('textbox', { name: 'Search' });
  await expect(search).toHaveAttribute('data-slot', 'input');
  await search.fill('no-design-system-match');
  await page.locator('select[name="type"]').selectOption('skill');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page).toHaveURL(/q=no-design-system-match/);
  await expect(page.locator('select[name="type"]')).toHaveValue('skill');
  await expect(page.locator('select[name="type"]')).toHaveAttribute('data-slot', 'native-select');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByText('Navigation', { exact: true }).click();
  await page.locator('details').getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Path or GitHub URL' })).toHaveAttribute(
    'data-slot',
    'input',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('repositories-mobile.png'), fullPage: true });
});
