import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_AGENTS,
  detectAllCliAgents,
  detectCliAgent,
  type CliAgentDescriptor,
} from '../src/detection';

// Fake executables are POSIX shell scripts; real `claude`/`codex`/`cursor-agent` installs are
// never consulted because every test controls PATH.
const posixOnly = describe.skipIf(process.platform === 'win32');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeScript(dir: string, name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

function descriptor(executable: string): CliAgentDescriptor {
  return {
    id: executable,
    displayName: executable,
    executable,
    versionArgs: ['--version'],
    specPath: '',
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLI_AGENTS', () => {
  it('describes Claude Code, Codex and Cursor Agent with their specs', () => {
    expect(CLI_AGENTS.map((a) => [a.id, a.executable])).toEqual([
      ['claude-code', 'claude'],
      ['codex', 'codex'],
      ['cursor', 'cursor-agent'],
    ]);
    for (const agent of CLI_AGENTS) expect(agent.specPath).toMatch(/^\.ai\/specs\/.+\.md$/);
  });
});

describe('detectCliAgent', () => {
  it('reports a missing executable without throwing', async () => {
    const detection = await detectCliAgent(descriptor('definitely-not-installed-xyz'), {
      PATH: tempDir('empty-'),
    });
    expect(detection).toEqual({
      adapterId: 'definitely-not-installed-xyz',
      installed: false,
      version: null,
      executablePath: null,
      auth: 'unknown',
      notes: ['`definitely-not-installed-xyz` was not found on PATH.'],
    });
  });

  it('treats an environment without PATH as having no executables', async () => {
    const detection = await detectCliAgent(descriptor('sh'), {});
    expect(detection).toMatchObject({ installed: false, executablePath: null });
  });

  posixOnly('with fake executables on PATH', () => {
    it('reads the first line of the version output', async () => {
      const dir = tempDir('bin-');
      const bin = writeScript(dir, 'fake-agent', 'echo "  fake-agent 1.2.3  "\necho "extra line"');
      const detection = await detectCliAgent(descriptor('fake-agent'), { PATH: dir });
      expect(detection).toEqual({
        adapterId: 'fake-agent',
        installed: true,
        version: 'fake-agent 1.2.3',
        executablePath: bin,
        auth: 'unknown',
        notes: [
          'Detected on PATH.',
          'Benchmark execution through this agent is not implemented yet.',
        ],
      });
    });

    it('passes the descriptor version arguments', async () => {
      const dir = tempDir('bin-');
      writeScript(dir, 'args-agent', 'echo "args: $*"');
      const detection = await detectCliAgent(
        { ...descriptor('args-agent'), versionArgs: ['version', '--short'] },
        { PATH: dir },
      );
      expect(detection.version).toBe('args: version --short');
    });

    it('truncates very long version lines to 200 characters', async () => {
      const dir = tempDir('bin-');
      writeScript(dir, 'long-agent', `printf '%0300d\\n' 0`);
      const detection = await detectCliAgent(descriptor('long-agent'), { PATH: dir });
      expect(detection.version).toBe('0'.repeat(200));
    });

    it('reports a failing version command as installed without a version', async () => {
      const dir = tempDir('bin-');
      writeScript(dir, 'broken-agent', 'echo "boom" >&2\nexit 3');
      const detection = await detectCliAgent(descriptor('broken-agent'), { PATH: dir });
      expect(detection).toMatchObject({ installed: true, version: null });
      expect(detection.notes[0]).toBe('Found on PATH but the version command failed.');
    });

    it('reports empty version output as no version', async () => {
      const dir = tempDir('bin-');
      writeScript(dir, 'silent-agent', 'exit 0');
      const detection = await detectCliAgent(descriptor('silent-agent'), { PATH: dir });
      expect(detection).toMatchObject({ installed: true, version: null });
    });

    it('skips non-executable files and empty PATH entries, using the first match', async () => {
      const first = tempDir('bin-');
      const second = tempDir('bin-');
      const third = tempDir('bin-');
      writeScript(first, 'dup-agent', 'echo first', 0o644);
      const expected = writeScript(second, 'dup-agent', 'echo second');
      writeScript(third, 'dup-agent', 'echo third');
      const detection = await detectCliAgent(descriptor('dup-agent'), {
        PATH: ['', first, '', second, third].join(delimiter),
      });
      expect(detection).toMatchObject({ executablePath: expected, version: 'second' });
    });

    it('defaults to the process environment', async () => {
      const dir = tempDir('bin-');
      writeScript(dir, 'env-agent', 'echo env 9');
      vi.stubEnv('PATH', dir);
      expect((await detectCliAgent(descriptor('env-agent'))).version).toBe('env 9');
    });

    describe('on Windows', () => {
      const realPlatform = process.platform;
      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: realPlatform });
      });
      function pretendWindows() {
        Object.defineProperty(process, 'platform', { value: 'win32' });
      }

      it('appends the default PATHEXT extensions', async () => {
        const dir = tempDir('bin-');
        const bin = writeScript(dir, 'win-agent.CMD', 'echo win 1');
        writeScript(dir, 'win-agent', 'echo no extension');
        pretendWindows();
        const detection = await detectCliAgent(descriptor('win-agent'), { PATH: dir });
        expect(detection).toMatchObject({ executablePath: bin, version: 'win 1' });
      });

      it('honours a custom PATHEXT', async () => {
        const dir = tempDir('bin-');
        writeScript(dir, 'win-agent.EXE', 'echo default ext');
        const bin = writeScript(dir, 'win-agent.PS1', 'echo custom ext');
        pretendWindows();
        const detection = await detectCliAgent(descriptor('win-agent'), {
          PATH: dir,
          PATHEXT: '.PS1',
        });
        expect(detection).toMatchObject({ executablePath: bin, version: 'custom ext' });
      });
    });
  });
});

posixOnly('detectAllCliAgents', () => {
  it('detects every known agent against the given PATH', async () => {
    const dir = tempDir('bin-');
    writeScript(dir, 'claude', 'echo "2.0.0 (Claude Code)"');
    writeScript(dir, 'codex', 'exit 1');
    const results = await detectAllCliAgents({ PATH: dir });
    expect(results.map((r) => r.descriptor)).toEqual(CLI_AGENTS);
    expect(results.map(({ detection: d }) => [d.adapterId, d.installed, d.version])).toEqual([
      ['claude-code', true, '2.0.0 (Claude Code)'],
      ['codex', true, null],
      ['cursor', false, null],
    ]);
  });

  it('defaults to the process environment', async () => {
    const dir = tempDir('bin-');
    writeScript(dir, 'cursor-agent', 'echo cursor 7');
    vi.stubEnv('PATH', dir);
    const results = await detectAllCliAgents();
    expect(results.map((r) => r.detection.version)).toEqual([null, null, 'cursor 7']);
  });
});
