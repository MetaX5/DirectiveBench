import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * SPEC-120 (tokeny.md U01–U10): control boundaries, focus indicators and ScoreBar fills reach
 * 3:1 against the surface they sit on, in both themes. Colours are measured as rendered pixels
 * because production CSS may serialise OKLCH as Lab.
 */

type Measured = { name: string; ratio: number };

// Returns the contrast of each requested colour of the element against its composited
// ancestor background (or against the background of `against`, when given).
async function contrast(
  element: Locator,
  colours: 'border' | 'ring' | 'outline' | 'background',
  against?: Locator,
): Promise<number[]> {
  const backdrop = await (against ?? element).evaluate((el, own) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 1, 1);
    const stack: Element[] = [];
    for (let p: Element | null = own ? el : el.parentElement; p; p = p.parentElement) {
      stack.unshift(p);
    }
    for (const p of stack) {
      ctx.fillStyle = getComputedStyle(p).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
    }
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, Boolean(against));
  return element.evaluate(
    (el, { colours, backdrop }) => {
      const style = getComputedStyle(el);
      let found: string[];
      if (colours === 'border') found = [style.borderTopColor];
      else if (colours === 'background') found = [style.backgroundColor];
      else if (colours === 'outline')
        found = style.outlineStyle === 'none' ? [] : [style.outlineColor];
      else {
        // Ring layers are box-shadows with a non-zero spread; skip the empty Tailwind layers.
        found = style.boxShadow
          .split(/,(?![^(]*\))/)
          .filter((layer) => / [1-9][\d.]*px(?: inset)?$/.test(layer.trim()))
          .flatMap((layer) => layer.match(/(?:rgba?|oklch|oklab|lab|lch|color)\([^)]*\)/) ?? []);
      }
      const ctx = document.createElement('canvas').getContext('2d')!;
      const luminance = (rgb: number[]) =>
        rgb.reduce((sum, v, i) => {
          const c = v / 255;
          return (
            sum +
            (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!
          );
        }, 0);
      return found.map((colour) => {
        ctx.fillStyle = `rgb(${backdrop.join(' ')})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        const fg = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        const l = [luminance(fg), luminance(backdrop)];
        return (Math.max(...l) + 0.05) / (Math.min(...l) + 0.05);
      });
    },
    { colours, backdrop },
  );
}

async function record(results: Measured[], name: string, ratios: Promise<number[]>) {
  const values = await ratios;
  expect.soft(values.length, `${name}: colour found`).toBeGreaterThan(0);
  for (const ratio of values) {
    results.push({ name, ratio });
    expect.soft(ratio, name).toBeGreaterThanOrEqual(3);
  }
}

async function keyboardFocus(page: Page, element: Locator) {
  // A key press first makes Chromium treat the following programmatic focus as keyboard focus.
  await page.keyboard.press('Shift');
  await element.focus();
}

for (const theme of ['light', 'dark'] as const) {
  test(`control boundaries, focus indicators and score bars reach 3:1 in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const results: Measured[] = [];

    await page.goto('/repositories');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    const input = page.getByRole('textbox', { name: 'Path or GitHub URL' });
    await record(results, 'input border', contrast(input, 'border'));
    await keyboardFocus(page, input);
    await record(results, 'input focus border', contrast(input, 'border'));
    await record(results, 'input focus ring', contrast(input, 'ring'));
    const register = page.getByRole('button', { name: 'Register', exact: true });
    await keyboardFocus(page, register);
    // Buttons draw their focus outline 2px outside the fill, on the page (tokeny.md D4).
    await record(results, 'primary button focus outline', contrast(register, 'outline'));

    // The home directory needs a confirmation (D05), whose submit is the destructive button;
    // it is cancelled below, so nothing is registered.
    await input.fill('~');
    await register.click();
    const confirmation = page.getByTestId('registration-confirmation');
    const registerAnyway = confirmation.getByRole('button', { name: 'Register anyway' });
    await expect(registerAnyway).toBeVisible({ timeout: 30_000 });
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await keyboardFocus(page, registerAnyway);
    await record(results, 'destructive button focus outline', contrast(registerAnyway, 'outline'));
    await confirmation.getByRole('link', { name: 'Cancel' }).click();
    await expect(confirmation).toHaveCount(0);

    await page.goto('/artifacts');
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    const select = page.locator('select[name="type"]');
    await record(results, 'select border', contrast(select, 'border'));
    await keyboardFocus(page, select);
    await record(results, 'select focus ring', contrast(select, 'ring'));
    const navItem = page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Repositories', exact: true });
    await keyboardFocus(page, navItem);
    await record(results, 'navigation focus ring', contrast(navItem, 'ring'));
    const activeNavItem = page
      .getByRole('navigation', { name: 'Main' })
      .locator('a[aria-current="page"]');
    await keyboardFocus(page, activeNavItem);
    await record(results, 'active navigation focus ring', contrast(activeNavItem, 'ring'));

    await page.goto('/results');
    const run = page.locator('main a[href^="/results/"]').first();
    await run.click();
    const bars = page.locator('[data-slot="score-bar"]');
    await expect(bars.first()).toBeVisible();
    let measuredBars = 0;
    for (const bar of await bars.all()) {
      const fill = bar.locator('[data-slot="score-bar-fill"]');
      const tone = await fill.getAttribute('data-tone');
      if ((await fill.boundingBox())?.width) {
        measuredBars += 1;
        await record(results, `score bar ${tone} fill`, contrast(fill, 'background', bar));
      }
    }
    expect(measuredBars, 'score bars with a visible fill').toBeGreaterThan(0);

    await testInfo.attach('ui-contrast-ratios', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });
}
