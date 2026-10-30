import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  COMPARE_AGENT_RUN,
  COMPARE_CASE,
  COMPARE_RUN,
  cleanUp as cleanUpCompare,
  reseed as reseedCompare,
} from './compare-seed';
import { AGENT_RUN, CODE_RUN, cleanUp, reseed } from './output-files-seed';
import { withDatabase } from './support';

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

    // SPEC-123 D31: the selected file's left border is its non-colour cue, so it needs 3:1; the
    // file links and the "View files" link show the focus outline.
    const viewFiles = page
      .getByTestId('output-files')
      .getByRole('link', { name: /^View files of / })
      .first();
    await keyboardFocus(page, viewFiles);
    await record(results, 'view files link focus outline', contrast(viewFiles, 'outline'));
    await viewFiles.click();
    const current = page
      .getByRole('navigation', { name: 'Changed files' })
      .locator('a[aria-current="page"]');
    await expect(current).toBeVisible();
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await record(results, 'selected file border', contrast(current, 'border'));
    await keyboardFocus(page, current);
    await record(results, 'file link focus outline', contrast(current, 'outline'));

    // SPEC-123 D36, D43, D44: the compare page's entry link, its selected path border (the
    // non-colour cue) and the path link focus outline.
    await page.getByRole('link', { name: 'Back to the run' }).click();
    const compare = page
      .getByTestId('output-files')
      .getByRole('link', { name: /^Compare agent runs of case / })
      .first();
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await keyboardFocus(page, compare);
    await record(results, 'compare link focus outline', contrast(compare, 'outline'));
    await compare.click();
    const currentPath = page
      .getByRole('navigation', { name: 'Changed paths' })
      .locator('a[aria-current="page"]');
    await expect(currentPath).toBeVisible();
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await record(results, 'selected path border', contrast(currentPath, 'border'));
    await keyboardFocus(page, currentPath);
    await record(results, 'path link focus outline', contrast(currentPath, 'outline'));
    const runSelect = page.locator('select[name="left"]');
    await record(results, 'compare select border', contrast(runSelect, 'border'));
    await keyboardFocus(page, runSelect);
    await record(results, 'compare select focus ring', contrast(runSelect, 'ring'));

    await testInfo.attach('ui-contrast-ratios', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });
}

// SPEC-123 AC-14 (FR-123-73): every syntax colour, rendered on the files page, reaches 4.5:1 on
// the plain code surface and on the diff row tints (D11 removed and added, D12 neutral). The
// tints are the classes SideBySideDiff gives a row (code-lines.tsx); they are put on the
// rendered lines here, so the colours are measured on this page's real surface.
const SYNTAX_KINDS = [
  'foreground',
  'comment',
  'keyword',
  'string',
  'string-expression',
  'constant',
  'function',
  'parameter',
  'punctuation',
  'link',
];
const ROW_TINTS = ['', 'bg-destructive/10', 'bg-success/10', 'bg-info/10'];

type TokenContrast = { kind: string; tint: string; ratio: number };

// Contrast of every highlighted token on the page against its composited row background. With
// `tint`, each highlighted row first gets that tint class (or none for ''); without it, rows
// keep the tint the page gave them and are reported by their `data-tone`.
function measureTokens(page: Page, tint?: string): Promise<TokenContrast[]> {
  return page.evaluate((tint) => {
    const lines = [...document.querySelectorAll('[data-highlighted]')];
    if (tint !== undefined) {
      for (const line of lines) {
        const row = line.parentElement!;
        row.classList.remove('bg-destructive/10', 'bg-success/10', 'bg-info/10');
        if (tint) row.classList.add(tint);
      }
    }
    const ctx = document.createElement('canvas').getContext('2d')!;
    const pixel = (colour: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const blend = (fg: number[], bg: number[]) =>
      fg.slice(0, 3).map((v, i) => (v * fg[3]!) / 255 + bg[i]! * (1 - fg[3]! / 255));
    const luminance = (rgb: number[]) =>
      rgb.reduce((sum, v, i) => {
        const c = v / 255;
        const linear = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
      }, 0);
    const rows = [];
    for (const line of lines) {
      const rowTint = tint ?? line.parentElement!.getAttribute('data-tone') ?? '';
      for (const token of line.querySelectorAll('span')) {
        if (!token.textContent?.trim()) continue;
        const kind = /text-syntax-token-(\S+)/.exec(token.className)?.[1] ?? 'foreground';
        let bg = [255, 255, 255];
        const stack: Element[] = [];
        for (let p: Element | null = token; p; p = p.parentElement) stack.unshift(p);
        for (const p of stack) bg = blend(pixel(getComputedStyle(p).backgroundColor), bg);
        const fg = blend(pixel(getComputedStyle(token).color), bg);
        const l = [luminance(fg), luminance(bg)];
        rows.push({
          kind,
          tint: rowTint,
          ratio: (Math.max(...l) + 0.05) / (Math.min(...l) + 0.05),
        });
      }
    }
    return rows;
  }, tint);
}

test.describe('syntax colours (SPEC-123 AC-14)', () => {
  test.beforeAll(async () =>
    withDatabase((db) => {
      reseed(db);
      reseedCompare(db);
    }),
  );
  test.afterAll(async () =>
    withDatabase((db) => {
      cleanUp(db);
      cleanUpCompare(db);
    }),
  );

  for (const theme of ['light', 'dark'] as const) {
    test(`syntax colours reach 4.5:1 on the code surface and the diff tints in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      const measured: TokenContrast[] = [];
      for (const path of ['src/add.ts', 'src/fmt.py', 'README.md']) {
        await page.goto(
          `/results/${CODE_RUN}/agent-runs/${AGENT_RUN.code}?path=${encodeURIComponent(path)}`,
        );
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        await expect(page.locator('[data-highlighted]').first()).toBeVisible();
        for (const tint of ROW_TINTS) measured.push(...(await measureTokens(page, tint)));
      }
      for (const tint of ROW_TINTS) {
        const kinds = new Set(measured.filter((m) => m.tint === tint).map((m) => m.kind));
        expect([...kinds].sort(), `kinds measured on "${tint || 'surface'}"`).toEqual(
          [...SYNTAX_KINDS].sort(),
        );
      }
      const worst = SYNTAX_KINDS.flatMap((kind) =>
        ROW_TINTS.map((tint) => ({
          name: `${kind} on ${tint || 'the code surface'}`,
          ratio: Math.min(
            ...measured.filter((m) => m.kind === kind && m.tint === tint).map((m) => m.ratio),
          ),
        })),
      );
      for (const { name, ratio } of worst) expect.soft(ratio, name).toBeGreaterThanOrEqual(4.5);

      // The compare page renders the real D11 tints on removed and added rows (Phase 4).
      await page.goto(
        `/results/${COMPARE_RUN}/compare?case=${COMPARE_CASE}&left=${COMPARE_AGENT_RUN.baseline}&right=${COMPARE_AGENT_RUN.candidate}&path=src%2Frender.php`,
      );
      await expect(page.locator('[data-tone="added"] [data-highlighted]').first()).toBeVisible();
      const diff = await measureTokens(page);
      expect(new Set(diff.map((m) => m.tint))).toEqual(new Set(['', 'removed', 'added']));
      for (const { kind, tint, ratio } of diff) {
        expect
          .soft(ratio, `compare page: ${kind} on ${tint || 'a plain row'}`)
          .toBeGreaterThanOrEqual(4.5);
      }
      await testInfo.attach('syntax-contrast-ratios', {
        body: JSON.stringify({ worst, compare: diff }, null, 2),
        contentType: 'application/json',
      });
    });
  }
});
