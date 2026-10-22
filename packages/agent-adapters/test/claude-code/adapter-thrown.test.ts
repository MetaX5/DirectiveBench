import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as probe from '../../src/probe';
import { ClaudeCodeAdapter } from '../../src/claude-code';
import { pinWorkspace } from '../../src/workspace-pin';
import { bundle } from './helpers';

// A thrown value that is not an Error, and an Error whose message carries the key: neither
// happens with the real probes, so `findExecutable` is replaced to reach the adapter's one exit.
const thrown = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../../src/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof probe>();
  return { ...actual, findExecutable: () => Promise.reject(thrown.value) };
});

const KEY = 'planted-key-0c9e1a7f3b5d2e84';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function run(value: unknown) {
  thrown.value = value;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-adapter-thrown-')));
  roots.push(root);
  mkdirSync(join(root, 'workspace'));
  mkdirSync(join(root, 'scratch'));
  const adapter = new ClaudeCodeAdapter(
    { authMode: 'api-key' },
    { PATH: '/usr/bin', HOME: root, ANTHROPIC_API_KEY: KEY },
  );
  return adapter.run({
    workspace: await pinWorkspace(join(root, 'workspace')),
    installedPaths: [],
    scratchDir: join(root, 'scratch'),
    artifact: bundle('skill-md', { 'SKILL.md': '---\nname: pdf\n---\n' }),
    baselineArtifact: null,
    prompt: 'p',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    model: null,
    options: undefined,
  });
}

describe('ClaudeCodeAdapter: a thrown error leaves through the redacting exit', () => {
  it.each([
    ['a non-Error value', `plain ${KEY}`],
    ['an Error', new Error(`failed with ${KEY}`)],
  ])('%s becomes infrastructure-error without the key', async (_name, value) => {
    const result = await run(value);
    expect(result).toMatchObject({ status: 'infrastructure-error', warnings: [] });
    expect(result.errorCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.error).toContain('[REDACTED]');
  });
});
