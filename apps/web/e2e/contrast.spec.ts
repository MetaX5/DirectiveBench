import { expect, test } from '@playwright/test';
import { scanTextContrast } from './contrast';

// Issue 270: a scan right after a theme switch read the navigation links in the middle of their
// transition-colors (ratio 2.5 to 4.4) on a loaded runner. next-themes disables transitions only
// until its next timer, so a style recalculation that comes later still starts them. Here the
// theme class changes while every transition is stretched, which makes that race certain: the
// scan must still measure the settled colours of the new theme.
for (const [from, to] of [
  ['light', 'dark'],
  ['dark', 'light'],
] as const) {
  test(`a contrast scan measures settled colours while a ${from} to ${to} switch is transitioning`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: from });
    await page.goto('/repositories');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${from}\\b`));
    await page.addStyleTag({
      content:
        '* { transition-duration: 600s !important; transition-timing-function: steps(1, end) !important; }',
    });
    await page.evaluate(
      ([oldTheme, newTheme]) => {
        const root = document.documentElement;
        root.classList.replace(oldTheme, newTheme);
      },
      [from, to] as const,
    );
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${to}\\b`));
    const failures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
    expect(failures).toEqual([]);
  });
}
