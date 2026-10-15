import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll } from 'vitest';

/**
 * Returns a factory for temporary directories that are all removed after the calling test file.
 * Call once at module level of a test file.
 */
export function useTempDirs(): (prefix: string) => string {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), `directivebench-${prefix}-`));
    created.push(dir);
    return dir;
  };
}

/** A `node -e` command line; the benchmark engine never uses a shell, so scripts run via argv. */
export const nodeScript = (script: string): string[] => [process.execPath, '-e', script];

/**
 * Runs a full garbage collection, so tests can prove that state they rely on is strongly
 * referenced and not merely alive because the collector has not run yet.
 */
export async function collectGarbage(): Promise<void> {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  // Two passes with a macrotask between them: WeakRef targets survive until the end of the
  // job that last dereferenced them, and FinalizationRegistry callbacks run after a collection.
  gc();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}
