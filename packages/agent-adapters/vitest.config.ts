import { defineConfig } from 'vitest/config';
import { fullCoverage, tempDirGuard } from '../../vitest.shared';

export default defineConfig({
  test: { globalSetup: [tempDirGuard], coverage: fullCoverage(['src/**/*.ts']) },
});
