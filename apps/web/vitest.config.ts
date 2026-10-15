import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { fullCoverage } from '../../vitest.shared';

// Unit tests cover the web app's logic (server actions, database access, proxy, helpers). Pages
// and components are covered by the Playwright tests in e2e/ (SPEC-012 §3).
export default defineConfig({
  resolve: {
    // `server-only` throws outside the react-server export condition; tests run in plain Node.
    alias: { 'server-only': fileURLToPath(new URL('./test/server-only.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: fullCoverage(['lib/**/*.ts', 'proxy.ts']),
  },
});
