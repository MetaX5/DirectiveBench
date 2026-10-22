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
import { claudeExecutablePinIssue, pinClaudeExecutable } from '../../src/claude-code';

const posix = describe.skipIf(process.platform === 'win32');
const VERSION = '2.1.302 (Claude Code)';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function binary() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-pin-')));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  const executable = join(root, 'bin', 'claude');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  return { root, executable };
}

posix('claude executable pin', () => {
  it('passes the binary check through and pins the canonical path', async () => {
    const { root, executable } = binary();
    symlinkSync(executable, join(root, 'claude-link'));
    const lookup = await pinClaudeExecutable({
      executablePath: join(root, 'claude-link'),
      versionLine: VERSION,
    });
    expect(lookup).toMatchObject({
      ok: true,
      pin: { canonical: executable, versionLine: VERSION },
    });
    expect(await pinClaudeExecutable({ executablePath: null, versionLine: null })).toMatchObject({
      ok: false,
      code: 'binary-not-found',
    });
  });

  it('fails closed when the located path cannot be resolved', async () => {
    const { root } = binary();
    const lookup = await pinClaudeExecutable({
      executablePath: join(root, 'gone'),
      versionLine: VERSION,
    });
    expect(lookup).toEqual({
      ok: false,
      code: 'binary-not-found',
      detail: `\`claude\` at ${join(root, 'gone')} cannot be resolved (ENOENT).`,
    });
  });

  it('reports a re-linked ancestor of the pinned path', async () => {
    const { root, executable } = binary();
    const lookup = await pinClaudeExecutable({ executablePath: executable, versionLine: VERSION });
    if (!lookup.ok) throw new Error('not pinned');
    expect(await claudeExecutablePinIssue(lookup.pin)).toBeNull();
    renameSync(join(root, 'bin'), join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'bin'));
    expect(await claudeExecutablePinIssue(lookup.pin)).toBe(
      `claude at ${executable} now resolves to another file`,
    );
  });
});
