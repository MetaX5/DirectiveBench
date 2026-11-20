import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { fullCoverage, tempDirGuard } from '../../vitest.shared';

// Unit tests cover the web app's logic (server actions, database access, proxy, helpers). Pages
// and components are covered by the Playwright tests in e2e/ (SPEC-012 §3).
export default defineConfig({
  resolve: {
    // `server-only` throws outside the react-server export condition; tests run in plain Node.
    alias: { 'server-only': fileURLToPath(new URL('./test/server-only.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: [tempDirGuard],
    // The real-thread tests start the unbuilt worker entry `lib/syntax-highlight-worker.ts` in a
    // thread, which inherits this execArgv. Node strips TypeScript types by default only from
    // 22.18, so on older supported Node (the engines.node minimum, 22.16) the flag turns it on
    // (issue #266). The built app is unaffected: Next.js bundles the worker entry.
    execArgv: process.features.typescript ? [] : ['--experimental-strip-types'],
    coverage: fullCoverage(['lib/**/*.ts', 'proxy.ts']),
  },
});
