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
  // Internal workspace packages are bundled; third-party packages stay runtime dependencies.
  noExternal: [/^@directivebench\//],
  banner: { js: '#!/usr/bin/env node' },
  // Keep `node:` prefixes: `node:sqlite` has no unprefixed alias.
  removeNodeProtocol: false,
});
