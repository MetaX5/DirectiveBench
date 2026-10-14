// Assembles the publishable layout next to the tsup bundle:
//   dist/web         prebuilt Next.js app (started with `next start`)
//   dist/migrations  Drizzle SQL migrations
//   dist/examples    bundled examples used by `directivebench demo`
// See .ai/specs/2026-10-14-cli-architecture.md (packaging layout).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliDir, '..', '..');
const dist = join(cliDir, 'dist');
const webDir = join(repoRoot, 'apps', 'web');
const nextDir = join(webDir, '.next');

if (!existsSync(join(nextDir, 'BUILD_ID'))) {
  console.error('apps/web/.next is missing. Run `pnpm build` from the repository root first.');
  process.exit(1);
}

// Build artefacts that are not needed by `next start` (and may contain local paths).
// Source maps are excluded as well: they embed absolute source paths of the build machine.
const EXCLUDED = new Set(['cache', 'dev', 'trace', 'trace-build', 'types', 'diagnostics']);
const target = join(dist, 'web');
rmSync(target, { recursive: true, force: true });
cpSync(nextDir, join(target, '.next'), {
  recursive: true,
  filter: (source) => {
    const rel = relative(nextDir, source);
    const top = rel.split(/[\\/]/)[0];
    return !EXCLUDED.has(top) && !source.endsWith('.nft.json') && !source.endsWith('.map');
  },
});
cpSync(join(webDir, 'next.config.mjs'), join(target, 'next.config.mjs'));
if (existsSync(join(webDir, 'public')))
  cpSync(join(webDir, 'public'), join(target, 'public'), { recursive: true });

// required-server-files.json records absolute build paths (used by standalone output only).
// Replace them so the published package does not leak the build machine's file system layout.
for (const file of ['required-server-files.json', 'required-server-files.js']) {
  const path = join(target, '.next', file);
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf8').split(repoRoot).join('/build');
  writeFileSync(path, content);
}

cpSync(join(repoRoot, 'packages', 'database', 'migrations'), join(dist, 'migrations'), {
  recursive: true,
});
rmSync(join(dist, 'examples'), { recursive: true, force: true });
cpSync(join(repoRoot, 'examples'), join(dist, 'examples'), { recursive: true });
cpSync(join(repoRoot, 'LICENSE'), join(cliDir, 'LICENSE'));

console.log(`Assembled ${basename(dist)}/ (web, migrations, examples) and LICENSE`);
