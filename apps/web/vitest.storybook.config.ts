import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Stories as browser tests (SPEC-122 FR-122-1, FR-122-2): every story renders, runs its play
// function and passes axe, once per theme. Unit coverage stays in vitest.config.ts; stories are
// documentation, so coverage is off here.
const theme = (name: 'light' | 'dark') => ({
  extends: true,
  plugins: [storybookTest({ initialGlobals: { theme: name } })],
  test: {
    name: `storybook-${name}`,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' as const }],
    },
  },
});

export default defineConfig({
  test: {
    coverage: { enabled: false },
    projects: [theme('light'), theme('dark')],
  },
});
