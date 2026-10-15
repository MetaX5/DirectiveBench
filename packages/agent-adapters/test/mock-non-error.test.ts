import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgentAdapter } from '../src/mock';

// Node's fs never rejects with a non-Error, so the defensive `String(error)` path in the mock
// agent can only be exercised by making `writeFile` reject with a plain value.
const failure = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      failure.value === undefined ? actual.writeFile(...args) : Promise.reject(failure.value),
  };
});

const tempDirs: string[] = [];
afterEach(() => {
  failure.value = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MockAgentAdapter with a non-Error filesystem failure', () => {
  it('stringifies the thrown value into the agent error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    tempDirs.push(ws);
    failure.value = 'disk on fire';
    const result = await new MockAgentAdapter().run({
      workspaceDir: ws,
      prompt: 'task',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      model: null,
      options: { playbook: [{ id: 's', description: 'd', write: { path: 'a.txt', content: '' } }] },
    });
    expect(result).toMatchObject({
      status: 'agent-error',
      summary: 'Step s failed',
      error: 'disk on fire',
    });
    expect(result.trace.at(-1)).toEqual({ type: 'error', message: 'disk on fire' });
  });
});
