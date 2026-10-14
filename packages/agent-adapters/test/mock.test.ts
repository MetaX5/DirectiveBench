import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArtifactBundle } from '@directivebench/core';
import { detectCliAgent } from '../src/detection';
import { MockAgentAdapter } from '../src/mock';
import { PathEscapeError, resolveInside } from '../src/paths';

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

function request(workspaceDir: string, opts: unknown = options) {
  return {
    workspaceDir,
    prompt: 'task',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    model: null,
    options: opts,
  };
}

describe('MockAgentAdapter', () => {
  const adapter = new MockAgentAdapter();

  it('skips guarded steps when no artifact is installed (baseline)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    const result = await adapter.run(request(ws));
    expect(result.status).toBe('completed');
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('naive');
    expect(result.trace).toContainEqual(
      expect.objectContaining({ type: 'step-skipped', stepId: 'strict' }),
    );
  });

  it('follows directives from an installed skill (candidate)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    const installed = await adapter.installArtifact(ws, skill);
    expect(installed.paths).toEqual(['.agents/skills/validate-input/SKILL.md']);
    const result = await adapter.run(request(ws));
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('validated');
    expect(result.trace[0]).toEqual({
      type: 'context-loaded',
      files: ['.agents/skills/validate-input/SKILL.md'],
    });
  });

  it('installs instructions through AGENTS.md', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    await adapter.installArtifact(ws, { ...skill, type: 'instruction', format: 'agents-md' });
    await adapter.run(request(ws));
    expect(readFileSync(join(ws, 'src/a.js'), 'utf8')).toBe('validated');
  });

  it('reports invalid options and path escapes as agent errors', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    expect((await adapter.run(request(ws, {}))).status).toBe('agent-error');
    const escape = await adapter.run(
      request(ws, {
        playbook: [{ id: 'x', description: 'x', write: { path: '../evil', content: '' } }],
      }),
    );
    expect(escape.status).toBe('agent-error');
    expect(escape.error).toMatch(/escapes/);
  });

  it('refuses artifact files that escape the install directory', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mock-'));
    await expect(
      adapter.installArtifact(ws, {
        ...skill,
        files: [{ path: '../../../outside.txt', sha256: '', size: 0, content: '' }],
      }),
    ).rejects.toThrow(PathEscapeError);
  });
});

describe('resolveInside', () => {
  it('rejects absolute and parent paths', () => {
    expect(() => resolveInside('/ws', '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInside('/ws', 'a/../../b')).toThrow(PathEscapeError);
    expect(resolveInside('/ws', 'a/b')).toBe('/ws/a/b');
  });
});

describe('detectCliAgent', () => {
  it('reports missing executables without throwing', async () => {
    const detection = await detectCliAgent(
      {
        id: 'x',
        displayName: 'X',
        executable: 'definitely-not-installed-xyz',
        versionArgs: ['--version'],
        specPath: '',
      },
      { PATH: mkdtempSync(join(tmpdir(), 'empty-')) },
    );
    expect(detection).toMatchObject({ installed: false, version: null });
  });

  it.skipIf(process.platform === 'win32')(
    'reads the version of an executable on PATH',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bin-'));
      mkdirSync(dir, { recursive: true });
      const bin = join(dir, 'fake-agent');
      writeFileSync(bin, '#!/bin/sh\necho "fake-agent 1.2.3"\n');
      chmodSync(bin, 0o755);
      const detection = await detectCliAgent(
        {
          id: 'fake',
          displayName: 'Fake',
          executable: 'fake-agent',
          versionArgs: ['--version'],
          specPath: '',
        },
        { PATH: dir },
      );
      expect(detection).toMatchObject({
        installed: true,
        version: 'fake-agent 1.2.3',
        auth: 'unknown',
      });
    },
  );
});
