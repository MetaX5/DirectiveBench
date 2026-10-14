import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exit codes — see .ai/specs/2026-10-14-cli-architecture.md (§9). */
export const ExitCode = {
  Ok: 0,
  Runtime: 1,
  Usage: 2,
  UnsupportedRuntime: 3,
  PortInUse: 4,
  DataDir: 5,
  CheckFailed: 6,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  override name = 'CliError';
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
  }
}

export const MIN_NODE = [22, 16, 0] as const;

export function checkNodeVersion(version = process.versions.node): {
  ok: boolean;
  message: string;
} {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const [rMajor, rMinor, rPatch] = MIN_NODE;
  const ok =
    major > rMajor ||
    (major === rMajor && (minor > rMinor || (minor === rMinor && patch >= rPatch)));
  return { ok, message: `Node.js ${version} (requires >= ${MIN_NODE.join('.')})` };
}

export async function checkSqlite(): Promise<{ ok: boolean; message: string }> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const statement = db.prepare('select sqlite_version() as v');
    statement.setReturnArrays(true);
    const row = statement.get() as unknown as [string];
    db.close();
    return { ok: true, message: `node:sqlite available (SQLite ${row[0]})` };
  } catch (error) {
    return { ok: false, message: `node:sqlite unavailable: ${(error as Error).message}` };
  }
}

export function assertSupportedRuntime(): void {
  const node = checkNodeVersion();
  if (!node.ok)
    throw new CliError(`Unsupported runtime: ${node.message}`, ExitCode.UnsupportedRuntime);
}

export interface Assets {
  mode: 'packaged' | 'source';
  /** Directory passed to `next start` / `next dev`. */
  webDir: string;
  migrationsDir: string;
  examplesDir: string;
  /** Absolute path to the Next.js CLI entry. */
  nextBin: string;
}

/**
 * Locates bundled files relative to this file, never relative to the working directory.
 * Packaged: `dist/cli.js` next to `dist/{web,migrations,examples}`.
 * Source (development): `apps/cli/src/*.ts` inside the monorepo.
 */
export function resolveAssets(): Assets {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, 'web', '.next', 'BUILD_ID'))) {
    const require = createRequire(import.meta.url);
    return {
      mode: 'packaged',
      webDir: join(here, 'web'),
      migrationsDir: join(here, 'migrations'),
      examplesDir: join(here, 'examples'),
      nextBin: require.resolve('next/dist/bin/next'),
    };
  }
  const repoRoot = resolve(here, '..', '..', '..');
  const webDir = join(repoRoot, 'apps', 'web');
  if (!existsSync(join(webDir, 'package.json'))) {
    throw new CliError(
      `Cannot locate the bundled web application next to ${here}`,
      ExitCode.Runtime,
    );
  }
  return {
    mode: 'source',
    webDir,
    migrationsDir: join(repoRoot, 'packages', 'database', 'migrations'),
    examplesDir: join(repoRoot, 'examples'),
    nextBin: createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next'),
  };
}
