import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  // Everything that can be bundled is bundled (SPEC-004 dependency policy): internal workspace
  // packages and pure-JS libraries. Only Next.js and React stay runtime dependencies because the
  // prebuilt web app is started with `next start`.
  noExternal: [/^@directivebench\//, 'commander', /^drizzle-orm(\/|$)/, 'yaml', 'zod'],
  banner: {
    // Bundled CommonJS dependencies (e.g. yaml) call require(); ESM output needs a real one.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __directivebenchCreateRequire } from 'node:module';",
      'const require = __directivebenchCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  // Keep `node:` prefixes: `node:sqlite` has no unprefixed alias.
  removeNodeProtocol: false,
});
