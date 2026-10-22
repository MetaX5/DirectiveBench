import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claudeExecutablePinIssue,
  pinClaudeExecutable,
  shebangCommand,
  type ClaudeExecutablePin,
} from '../../src/claude-code';

const posix = describe.skipIf(process.platform === 'win32');
const VERSION = '2.1.302 (Claude Code)';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function script(path: string, shebang: string): void {
  writeFileSync(path, `${shebang}\nexit 0\n`, { mode: 0o755 });
}

/** `root/bin/claude` with the given `#!` line, and `root/interp/fake-node` (a shell script). */
function binary(shebang = '#!/bin/sh') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-pin-')));
  roots.push(root);
  for (const dir of ['bin', 'interp', 'early']) mkdirSync(join(root, dir));
  const executable = join(root, 'bin', 'claude');
  script(executable, shebang);
  script(join(root, 'interp', 'fake-node'), '#!/bin/sh');
  const env = { PATH: `${join(root, 'early')}:${join(root, 'interp')}:/usr/bin:/bin` };
  return { root, executable, env };
}

async function pinned(executable: string, env: NodeJS.ProcessEnv): Promise<ClaudeExecutablePin> {
  const lookup = await pinClaudeExecutable(
    { executablePath: executable, versionLine: VERSION },
    env,
  );
  if (!lookup.ok) throw new Error(lookup.detail);
  return lookup.pin;
}

describe('shebangCommand', () => {
  it.each([
    ['\u007fELF', null],
    ['#!', null],
    ['#!/bin/sh -e\nexit', '/bin/sh'],
    ['#!/usr/bin/env node\n', 'node'],
    ['#! /usr/bin/env -S NODE_OPTIONS=--x node --flag\n', 'node'],
    ['#!/usr/bin/env\n', null],
    ['#!/usr/bin/env -S\n', null],
  ])('%j → %s', (head, command) => {
    expect(shebangCommand(head)).toBe(command);
  });
});

posix('claude executable pin', () => {
  it('passes the binary check through and pins the canonical path and an absolute interpreter', async () => {
    const { root, executable, env } = binary();
    symlinkSync(executable, join(root, 'claude-link'));
    const pin = await pinned(join(root, 'claude-link'), env);
    expect(pin).toMatchObject({
      command: executable,
      canonical: executable,
      versionLine: VERSION,
      interpreter: { command: '/bin/sh', canonical: realpathSync('/bin/sh') },
    });
    expect(await claudeExecutablePinIssue(pin, env)).toBeNull();
    expect(
      await pinClaudeExecutable({ executablePath: null, versionLine: null }, env),
    ).toMatchObject({ ok: false, code: 'binary-not-found' });
  });

  it('pins a binary without a #! line without an interpreter', async () => {
    const { executable, env } = binary();
    writeFileSync(executable, '\u007fELF binary', { mode: 0o755 });
    const pin = await pinned(executable, env);
    expect(pin.interpreter).toBeNull();
    expect(await claudeExecutablePinIssue(pin, env)).toBeNull();
  });

  it('fails closed when the located path cannot be resolved', async () => {
    const { root, env } = binary();
    const lookup = await pinClaudeExecutable(
      { executablePath: join(root, 'gone'), versionLine: VERSION },
      env,
    );
    expect(lookup).toEqual({
      ok: false,
      code: 'binary-not-found',
      detail: `\`claude\` at ${join(root, 'gone')} cannot be resolved (ENOENT).`,
    });
  });

  it('refuses an env launcher whose interpreter is not on PATH', async () => {
    const { executable } = binary('#!/usr/bin/env fake-node');
    const lookup = await pinClaudeExecutable(
      { executablePath: executable, versionLine: VERSION },
      { PATH: '/nonexistent' },
    );
    expect(lookup).toMatchObject({ ok: false, code: 'binary-not-found' });
    expect(lookup.ok ? '' : lookup.detail).toMatch(/^The interpreter `fake-node` of `claude`/);
  });

  it('reports a re-linked ancestor of the pinned path', async () => {
    const { root, executable, env } = binary();
    const pin = await pinned(executable, env);
    renameSync(join(root, 'bin'), join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'bin'));
    expect(await claudeExecutablePinIssue(pin, env)).toBe(
      `${executable} now resolves to another file than ${executable}`,
    );
  });

  it('pins the interpreter an env line finds on PATH and reports a planted or replaced one (Codex round 3)', async () => {
    const { root, executable, env } = binary('#!/usr/bin/env fake-node');
    const pin = await pinned(executable, env);
    const interpreter = join(root, 'interp', 'fake-node');
    expect(pin.interpreter).toMatchObject({ command: 'fake-node', canonical: interpreter });
    expect(await claudeExecutablePinIssue(pin, env)).toBeNull();

    // Planted earlier on PATH: the launcher is unchanged, the interpreter is not.
    script(join(root, 'early', 'fake-node'), '#!/bin/sh');
    expect(await claudeExecutablePinIssue(pin, env)).toBe(
      `fake-node now resolves to another file than ${interpreter}`,
    );
    rmSync(join(root, 'early', 'fake-node'));

    // Replaced at its own path (a new inode).
    script(join(root, 'interp', 'new'), '#!/bin/sh');
    renameSync(join(root, 'interp', 'new'), interpreter);
    expect(await claudeExecutablePinIssue(pin, env)).toBe(
      `${interpreter} was replaced or changed after it was located`,
    );

    // Gone from PATH.
    expect(await claudeExecutablePinIssue(pin, { PATH: '/nonexistent' })).toBe(
      'fake-node is no longer found on PATH',
    );
  });
});
