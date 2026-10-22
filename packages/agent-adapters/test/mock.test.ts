import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactBundle } from '@directivebench/core';
import type { AgentRunRequest } from '../src/contract';
import { MOCK_AGENT_ID, MOCK_AGENT_VERSION, MockAgentAdapter } from '../src/mock';
import { PathEscapeError } from '../src/paths';
import type { WorkspacePin } from '../src/workspace-pin';

const skill: ArtifactBundle = {
  artifactId: 'art_1',
  versionId: 'artv_1',
  slug: 'validate-input',
  name: 'validate-input',
  type: 'skill',
  format: 'skill-md',
  contentHash: 'h',
  files: [{ path: 'SKILL.md', sha256: 'x', size: 10, content: 'Always VALIDATE external input.' }],
};

const options = {
  playbook: [
    { id: 'base', description: 'naive', write: { path: 'src/a.js', content: 'naive' } },
    {
      id: 'strict',
      description: 'validated',
      when: { contextIncludes: 'validate external input' },
      write: { path: 'src/a.js', content: 'validated' },
    },
  ],
};

function request(
  workspaceDir: string,
  opts: unknown = options,
  signal = new AbortController().signal,
): AgentRunRequest {
  return {
    workspace: pin(workspaceDir),
    installedPaths: [],
    scratchDir: workspaceDir,
    artifact: skill,
    baselineArtifact: null,
    prompt: 'task',
    timeoutMs: 1000,
    signal,
    model: null,
    options: opts,
  };
}

/** The mock reads and writes `workspace.path` only; it never checks the pin's identity. */
function pin(path: string): WorkspacePin {
  return { path, canonical: path, dev: 0, ino: 0 };
}

const tempDirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MockAgentAdapter', () => {
  const adapter = new MockAgentAdapter();

  it('identifies itself as a deterministic mock that needs no auth', async () => {
    expect(adapter.id).toBe(MOCK_AGENT_ID);
    expect(adapter.displayName).toMatch(/mock/i);
    expect(adapter.displayName).toMatch(/no AI/);
    expect(adapter.capabilities).toMatchObject({ execution: true, deterministic: true });
    expect(await adapter.detect()).toEqual({
      adapterId: 'mock',
      installed: true,
      version: MOCK_AGENT_VERSION,
      executablePath: null,
      auth: 'not-required',
      notes: ['Built-in deterministic mock; results are not AI evaluations.'],
    });
  });

  it('skips guarded steps when no artifact is installed (baseline)', async () => {
    const ws = workspace();
    const result = await adapter.run(request(ws));
    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Applied 1 of 2 playbook steps',
      usage: null,
      error: null,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('naive');
    expect(result.trace).toEqual([
      { type: 'context-loaded', files: [] },
      { type: 'step-applied', stepId: 'base', description: 'naive' },
      { type: 'file-written', path: 'src/a.js', bytes: 5 },
      {
        type: 'step-skipped',
        stepId: 'strict',
        description: 'validated',
        reason: 'instruction context does not contain "validate external input"',
      },
      { type: 'message', text: 'Applied 1 of 2 playbook steps' },
    ]);
  });

  it('follows directives from an installed skill (candidate)', async () => {
    const ws = workspace();
    const installed = await adapter.installArtifact(pin(ws), skill);
    expect(installed.paths).toEqual(['.agents/skills/validate-input/SKILL.md']);
    const result = await adapter.run(request(ws));
    expect(result.summary).toBe('Applied 2 of 2 playbook steps');
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('validated');
    expect(result.trace[0]).toEqual({
      type: 'context-loaded',
      files: ['.agents/skills/validate-input/SKILL.md'],
    });
  });

  it('installs instructions under .agents/instructions and appends them to AGENTS.md', async () => {
    const ws = workspace();
    const first = await adapter.installArtifact(pin(ws), {
      ...skill,
      type: 'instruction',
      format: 'agents-md',
    });
    expect(first.paths).toEqual(['.agents/instructions/validate-input/SKILL.md', 'AGENTS.md']);
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe('Always VALIDATE external input.');

    await adapter.installArtifact(pin(ws), {
      ...skill,
      slug: 'second-rule',
      type: 'rule',
      files: [
        { path: 'a.md', sha256: '', size: 1, content: 'Rule A.' },
        { path: 'b.md', sha256: '', size: 1, content: 'Rule B.' },
      ],
    });
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(
      'Always VALIDATE external input.\n\nRule A.\n\nRule B.',
    );

    const result = await adapter.run(request(ws));
    expect(result.trace[0]).toEqual({ type: 'context-loaded', files: ['AGENTS.md'] });
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('validated');
  });

  it('loads AGENTS.md and skill directories in name order, ignoring stray entries', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'AGENTS.md'), 'root rules');
    const skills = join(ws, '.agents', 'skills');
    for (const name of ['zeta', 'alpha', 'empty'])
      mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, 'zeta', 'SKILL.md'), 'zeta skill');
    writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'alpha skill');
    writeFileSync(join(skills, 'loose.md'), 'validate external input');

    const result = await adapter.run(request(ws));
    expect(result.trace[0]).toEqual({
      type: 'context-loaded',
      files: ['AGENTS.md', '.agents/skills/alpha/SKILL.md', '.agents/skills/zeta/SKILL.md'],
    });
    // The loose file is not a skill, so the guarded step must not fire.
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('naive');
  });

  it('rejects invalid options as an agent error without touching the workspace', async () => {
    const ws = workspace();
    for (const opts of [null, {}, { playbook: [] }, { ...options, extra: true }]) {
      const result = await adapter.run(request(ws, opts));
      expect(result).toMatchObject({
        status: 'agent-error',
        summary: 'Mock agent could not start',
      });
      expect(result.error).toMatch(/^Invalid mock agent options: /);
      expect(result.trace).toEqual([{ type: 'error', message: result.error }]);
    }
  });

  it('reports a path escape as an agent error and stops', async () => {
    const ws = workspace();
    const result = await adapter.run(
      request(ws, {
        playbook: [
          { id: 'x', description: 'x', write: { path: '../evil', content: '' } },
          { id: 'y', description: 'y', write: { path: 'never.txt', content: '' } },
        ],
      }),
    );
    expect(result).toMatchObject({ status: 'agent-error', summary: 'Step x failed' });
    expect(result.error).toMatch(/escapes/);
    expect(result.trace.at(-1)).toEqual({ type: 'error', message: result.error });
    expect(() => readFileSync(join(ws, 'never.txt'))).toThrow();
  });

  it('reports a filesystem failure as an agent error', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'blocker'), 'a file, not a directory');
    const result = await adapter.run(
      request(ws, {
        playbook: [
          { id: 'nested', description: 'n', write: { path: 'blocker/x.txt', content: '' } },
        ],
      }),
    );
    expect(result).toMatchObject({ status: 'agent-error', summary: 'Step nested failed' });
    expect(result.error).toMatch(/EEXIST|ENOTDIR/);
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const ws = workspace();
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.run(request(ws, options, controller.signal));
    expect(result).toMatchObject({ status: 'cancelled', summary: 'Cancelled', error: null });
    expect(() => readFileSync(join(ws, 'src/a.js'))).toThrow();
  });

  it('refuses artifact files that escape the install directory', async () => {
    const ws = workspace();
    await expect(
      adapter.installArtifact(pin(ws), {
        ...skill,
        files: [{ path: '../../../outside.txt', sha256: '', size: 0, content: '' }],
      }),
    ).rejects.toThrow(PathEscapeError);
  });

  it('never overwrites an existing artifact file', async () => {
    const ws = workspace();
    await adapter.installArtifact(pin(ws), skill);
    await expect(adapter.installArtifact(pin(ws), skill)).rejects.toThrow(/EEXIST/);
  });
});
