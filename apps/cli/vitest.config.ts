import { defineConfig } from 'vitest/config';

export default defineConfig({
  // dist/ contains bundled example fixtures with their own *.test.js files (run by the mock
  // benchmark, not by Vitest).
  test: { include: ['test/**/*.test.ts'] },
});
