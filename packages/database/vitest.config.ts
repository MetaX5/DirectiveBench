import { defineConfig } from 'vitest/config';
import { fullCoverage } from '../../vitest.shared';

export default defineConfig({
  test: { coverage: fullCoverage(['src/**/*.ts']) },
});
