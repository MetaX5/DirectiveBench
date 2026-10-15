import { defineConfig } from 'vitest/config';
import { fullCoverage } from '../../vitest.shared';

export default defineConfig({
  test: {
    // dist/ contains bundled example fixtures with their own *.test.js files (run by the mock
    // benchmark, not by Vitest).
    include: ['test/**/*.test.ts'],
    coverage: fullCoverage(['src/**/*.ts']),
  },
});
