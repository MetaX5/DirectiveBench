import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`/`TMP` on Windows. */
const TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * The runner's default workspace root (`LocalRunner`, `packages/runner/src/runner.ts`). The CLI
 * runs benchmarks with it, and production keeps the directory on purpose, so it may remain; the
 * run workspaces inside it may not.
 */
const RUNNER_WORKSPACE_ROOT = ['directivebench', 'workspaces'] as const;

/** Entries left below `root`, sorted, as `/`-joined relative paths; descends the allowed root only. */
function leftoversIn(root: string, prefix: readonly string[] = []): string[] {
  const allowed = RUNNER_WORKSPACE_ROOT[prefix.length];
  const dir = join(root, ...prefix);
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = [...prefix, name];
      return name === allowed && lstatSync(join(dir, name)).isDirectory()
        ? leftoversIn(root, path)
        : [path.join('/')];
    });
}

/**
 * Points the temp-directory variables at a fresh private directory and returns a teardown that
 * restores them, removes the directory and throws when tests left anything in it (AGENTS.md §3).
 * A private directory per run keeps parallel package runs in one `TMPDIR` from seeing each
 * other's in-flight directories (issue #199).
 */
export function isolateTempDir(env: NodeJS.ProcessEnv = process.env): () => void {
  const root = mkdtempSync(join(tmpdir(), 'directivebench-vitest-'));
  const saved = TEMP_ENV_KEYS.map((key) => [key, env[key]] as const);
  for (const key of TEMP_ENV_KEYS) env[key] = root;

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    try {
      const leftovers = leftoversIn(root);
      if (leftovers.length > 0) {
        throw new Error(
          `Tests left ${leftovers.length} entries in the temp directory: ${leftovers.join(', ')}. ` +
            'Remove what a test creates in afterEach, afterAll or try/finally (AGENTS.md §3).',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Vitest `globalSetup` entry: runs once per package run, before any test worker starts. */
export default function setup(): () => void {
  return isolateTempDir();
}
