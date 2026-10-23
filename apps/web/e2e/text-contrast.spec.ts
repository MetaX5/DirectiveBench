import { expect, test, type Page } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '../components/ui/badge';

// Measure computed colours, including translucent status surfaces; source token strings
// can be normalized to different colour spaces by production CSS optimization.
async function scanTextContrast(page: Page) {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    function pixel(colour: string) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }
    function blend(fg: number[], bg: number[]) {
      const alpha = fg[3]! / 255;
      return fg.slice(0, 3).map((v, i) => v * alpha + bg[i]! * (1 - alpha));
    }
    function luminance(rgb: number[]) {
      return rgb.reduce((sum, v, i) => {
        const c = v / 255;
        return (
          sum +
          (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!
        );
      }, 0);
    }
    function check(el: Element, text: string, kind: 'text' | 'placeholder' = 'text') {
      if (
        el.closest(
          'button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled="true"]',
        )
      )
        return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none')
        return null;
      const stack = [];
      for (let p: Element | null = el; p; p = p.parentElement) stack.unshift(p);
      let bg = [255, 255, 255];
      let opacity = 1;
      for (const p of stack) {
        const s = getComputedStyle(p);
        bg = blend(pixel(s.backgroundColor), bg);
        opacity *= Number(s.opacity);
      }
      const colour =
        kind === 'placeholder' ? getComputedStyle(el, '::placeholder').color : style.color;
      let fg = pixel(colour);
      fg[3] = fg[3]! * opacity;
      fg = blend(fg, bg);
      const l = [luminance(fg), luminance(bg)];
      const ratio = (Math.max(...l) + 0.05) / (Math.min(...l) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.666 && Number(style.fontWeight) >= 700);
      return {
        text: text.trim().slice(0, 60),
        ratio,
        threshold: large ? 3 : 4.5,
        classes: el.getAttribute('class'),
        colour,
        background: bg,
        kind,
      };
    }
    const rows = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        !node.textContent?.trim() ||
        !node.parentElement ||
        node.parentElement.closest('script,style,option')
      )
        continue;
      const range = document.createRange();
      range.selectNode(node);
      if (![...range.getClientRects()].some((r) => r.width && r.height)) continue;
      const row = check(node.parentElement, node.textContent ?? '');
      if (row) rows.push(row);
    }
    for (const el of document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('input:not([type=hidden]), textarea, select')) {
      const value = el instanceof HTMLSelectElement ? el.selectedOptions[0]?.textContent : el.value;
      const placeholder = 'placeholder' in el ? el.placeholder : '';
      const text = value || placeholder;
      if (text) {
        const row = check(el, text, value ? 'text' : 'placeholder');
        if (row) rows.push(row);
      }
    }
    return rows;
  });
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
