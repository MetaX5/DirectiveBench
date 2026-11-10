import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import setup, { isolateTempDir } from '../../../vitest.tmp-guard';

/** Starts the guard on a fake environment and returns its private directory and teardown. */
function start(env: NodeJS.ProcessEnv = { TMPDIR: '/previous' }) {
  const teardown = isolateTempDir(env);
  const root = env.TMPDIR as string;
  return { env, root, teardown };
}

describe('isolateTempDir (the Vitest temp-directory guard, #199)', () => {
  it('points every temp variable at a private directory, then restores them and removes it', () => {
    const { env, root, teardown } = start();
    expect(root).toMatch(/directivebench-vitest-/);
    expect(env).toEqual({ TMPDIR: root, TMP: root, TEMP: root });
    expect(existsSync(root)).toBe(true);

    teardown();
    expect(env).toEqual({ TMPDIR: '/previous' });
    expect(existsSync(root)).toBe(false);
  });

  it('passes when the runner left only its empty default workspace root', () => {
    const { root, teardown } = start();
    mkdirSync(join(root, 'directivebench', 'workspaces'), { recursive: true });
    expect(teardown).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it('fails the run on a leftover and still removes the private directory', () => {
    const { root, teardown } = start();
    mkdirSync(join(root, 'directivebench-runner-abc'));
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(teardown).toThrow(
      'Tests left 2 entries in the temp directory: a.txt, directivebench-runner-abc. ' +
        'Remove what a test creates in afterEach, afterAll or try/finally (AGENTS.md §3).',
    );
    expect(existsSync(root)).toBe(false);
  });

  it('reports run workspaces and anything else inside the runner root', () => {
    const { root, teardown } = start();
    mkdirSync(join(root, 'directivebench', 'workspaces', 'run-2'), { recursive: true });
    mkdirSync(join(root, 'directivebench', 'workspaces', 'run-1'));
    writeFileSync(join(root, 'directivebench', 'other'), 'x');
    expect(teardown).toThrow(
      'entries in the temp directory: directivebench/other, directivebench/workspaces/run-1, ' +
        'directivebench/workspaces/run-2.',
    );
  });

  it('reports a file that only has the name of the runner root', () => {
    const { root, teardown } = start();
    writeFileSync(join(root, 'directivebench'), 'x');
    expect(teardown).toThrow('Tests left 1 entries in the temp directory: directivebench.');
  });

  it('guards the real process environment as the Vitest globalSetup entry', () => {
    const before = tmpdir();
    const teardown = setup();
    const root = tmpdir();
    expect(root).not.toBe(before);
    expect(process.env.TMPDIR).toBe(root);
    teardown();
    expect(tmpdir()).toBe(before);
    expect(existsSync(root)).toBe(false);
  });
});
