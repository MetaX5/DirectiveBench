import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTS_MD_IMPORT,
  claudeArtifactProfile,
  ClaudeCodeError,
  installClaudeArtifact,
  isClaudeInstallableFormat,
} from '../../src/claude-code';
import { pinWorkspace } from '../../src/workspace-pin';
import { bundle, installPinned } from './helpers';

let scratch: string;
let workspace: string;
let host: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'db-claude-install-'));
  workspace = join(scratch, 'workspace');
  host = join(scratch, 'host');
  await mkdir(workspace);
  await mkdir(host);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof ClaudeCodeError
      ? error.code
      : `not a ClaudeCodeError: ${String(error)}`;
  }
  return undefined;
}

const skill = bundle('skill-md', {
  'SKILL.md': '---\nname: pdf\n---\nFill PDFs.\n',
  'scripts/fill.py': 'print(1)\n',
});

describe('installClaudeArtifact (SPEC-203 §4.1)', () => {
  it('installs a skill with its files under .claude/skills/<slug>/', async () => {
    expect(await installPinned(workspace, skill)).toEqual({
      paths: ['.claude/skills/pdf/SKILL.md', '.claude/skills/pdf/scripts/fill.py'],
    });
    expect(await readFile(join(workspace, '.claude/skills/pdf/scripts/fill.py'), 'utf8')).toBe(
      'print(1)\n',
    );
  });

  it('installs a rule under .claude/rules/', async () => {
    const rule = bundle('claude-rule', { 'testing.md': '---\npaths: ["**/*.ts"]\n---\nTest.\n' });
    expect(await installPinned(workspace, rule)).toEqual({
      paths: ['.claude/rules/testing.md'],
    });
  });

  it('creates CLAUDE.md, or appends to the fixture copy after a blank line', async () => {
    const claudeMd = bundle('claude-md', { 'CLAUDE.md': 'Use tabs.' });
    expect(await installPinned(workspace, claudeMd)).toEqual({ paths: ['CLAUDE.md'] });
    expect(await readFile(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('Use tabs.');
    await installPinned(workspace, claudeMd);
    expect(await readFile(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('Use tabs.\n\nUse tabs.');
  });

  it('appends to an empty fixture file without a separator', async () => {
    await writeFile(join(workspace, 'CLAUDE.md'), '');
    await installPinned(workspace, bundle('claude-md', { 'CLAUDE.md': 'Rule.' }));
    expect(await readFile(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('Rule.');
  });

  it('installs AGENTS.md and imports it from CLAUDE.md for every Claude Code version', async () => {
    await writeFile(join(workspace, 'CLAUDE.md'), '# Fixture\n');
    const agentsMd = bundle('agents-md', { 'AGENTS.md': 'Agents rule.' });
    expect(await installPinned(workspace, agentsMd)).toEqual({
      paths: ['AGENTS.md', 'CLAUDE.md'],
    });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Agents rule.');
    expect(await readFile(join(workspace, 'CLAUDE.md'), 'utf8')).toBe(
      `# Fixture\n\n\n${AGENTS_MD_IMPORT}\n`,
    );
  });

  it('refuses formats without a Claude Code convention (FR-118-25)', async () => {
    for (const format of ['cursor-rule', 'copilot-instructions'] as const) {
      expect(await codeOf(() => installPinned(workspace, bundle(format, { 'x.md': 'x' })))).toBe(
        'artifact-format-unsupported',
      );
    }
  });

  it('refuses again, at install, a version that executes code or overrides the model (FR-118-26)', async () => {
    const hooks = bundle('skill-md', {
      'SKILL.md': '---\nname: pdf\ndescription: d\nhooks:\n  PreToolUse: []\n---\nBody\n',
    });
    await expect(installPinned(workspace, hooks)).rejects.toThrow(
      /^The artifact version is refused: SKILL\.md: .*hooks/,
    );
    expect(await codeOf(() => installPinned(workspace, hooks))).toBe('artifact-executes-code');
    const model = bundle('skill-md', {
      'SKILL.md': '---\nname: pdf\ndescription: d\nmodel: opus\n---\nBody\n',
    });
    expect(await codeOf(() => installPinned(workspace, model))).toBe('artifact-overrides-model');
    expect(await readdir(workspace)).toEqual([]);
  });

  it('refuses an existing skill directory and an existing rule file', async () => {
    await mkdir(join(workspace, '.claude/skills/pdf'), { recursive: true });
    expect(await codeOf(() => installPinned(workspace, skill))).toBe('artifact-install-conflict');
    await mkdir(join(workspace, '.claude/rules'), { recursive: true });
    await writeFile(join(workspace, '.claude/rules/testing.md'), 'fixture');
    expect(
      await codeOf(() => installPinned(workspace, bundle('claude-rule', { 'testing.md': 'x' }))),
    ).toBe('artifact-install-conflict');
  });

  it('never writes through a symbolic link a setup command planted', async () => {
    await symlink(host, join(workspace, '.claude'));
    expect(await codeOf(() => installPinned(workspace, skill))).toBe('artifact-install-conflict');
    expect(
      await codeOf(() => installPinned(workspace, bundle('claude-rule', { 'r.md': 'x' }))),
    ).toBe('artifact-install-conflict');
    await rm(join(workspace, '.claude'));
    await mkdir(join(workspace, '.claude'));
    await symlink(host, join(workspace, '.claude/skills'));
    expect(await codeOf(() => installPinned(workspace, skill))).toBe('artifact-install-conflict');

    const hostFile = join(host, 'CLAUDE.md');
    await writeFile(hostFile, 'host');
    await symlink(hostFile, join(workspace, 'CLAUDE.md'));
    expect(
      await codeOf(() => installPinned(workspace, bundle('claude-md', { 'CLAUDE.md': 'x' }))),
    ).toBe('artifact-install-conflict');
    await link(hostFile, join(workspace, 'AGENTS.md'));
    expect(
      await codeOf(() => installPinned(workspace, bundle('agents-md', { 'AGENTS.md': 'x' }))),
    ).toBe('artifact-install-conflict');
    expect(await readFile(hostFile, 'utf8')).toBe('host');
    expect((await lstat(join(host, 'pdf')).catch(() => null)) === null).toBe(true);
  });

  it('refuses a nested rule path, which could pass through a planted link', async () => {
    await mkdir(join(workspace, '.claude/rules'), { recursive: true });
    await symlink(host, join(workspace, '.claude/rules/sub'));
    expect(
      await codeOf(() => installPinned(workspace, bundle('claude-rule', { 'sub/r.md': 'x' }))),
    ).toBe('artifact-install-conflict');
    expect((await lstat(join(host, 'r.md')).catch(() => null)) === null).toBe(true);
  });

  it('leaves no staging directory behind, after success and after a refusal', async () => {
    await installPinned(workspace, skill);
    await installPinned(workspace, skill).catch(() => undefined);
    expect((await readdir(scratch)).sort()).toEqual(['host', 'workspace']);
  });

  it('refuses a .claude entry that is a file', async () => {
    await writeFile(join(workspace, '.claude'), 'file');
    expect(await codeOf(() => installPinned(workspace, skill))).toBe('artifact-install-conflict');
  });

  it('refuses a slug that is not one plain segment', async () => {
    expect(await codeOf(() => installPinned(workspace, { ...skill, slug: '../escape' }))).toBe(
      'artifact-install-conflict',
    );
  });

  it('propagates file system errors other than a conflict', async () => {
    const file = join(scratch, 'not-a-directory');
    await writeFile(file, 'x');
    await expect(pinWorkspace(file)).rejects.toThrow(/must be a real directory/);
    if (process.getuid?.() !== 0) {
      // A workspace that cannot be searched: reading CLAUDE.md fails with EACCES, not a conflict.
      await chmod(workspace, 0o600);
      try {
        expect(
          await codeOf(() => installPinned(workspace, bundle('claude-md', { 'CLAUDE.md': 'x' }))),
        ).toMatch(/EACCES/);
      } finally {
        await chmod(workspace, 0o700);
      }
    }
    const escapingSkill = bundle('skill-md', { 'SKILL.md': 'x', '../../evil.md': 'x' });
    expect(await codeOf(() => installPinned(workspace, escapingSkill))).toMatch(/PathEscapeError/);
    const escaping = bundle('claude-rule', { '../../outside.md': 'x' });
    expect(await codeOf(() => installPinned(workspace, escaping))).toBe(
      'artifact-install-conflict',
    );
  });
});

describe('installClaudeArtifact with a replaced workspace (SPEC-118 §12)', () => {
  it('refuses a workspace path a setup command replaced by a link to a host directory', async () => {
    const pin = await pinWorkspace(workspace);
    await rename(workspace, join(scratch, 'moved'));
    await symlink(host, workspace);
    for (const artifact of [skill, bundle('claude-md', { 'CLAUDE.md': 'x' })]) {
      expect(await codeOf(() => installClaudeArtifact(pin, artifact))).toBe('workspace-replaced');
    }
    expect(await readdir(host)).toEqual([]);
    expect((await readdir(scratch)).sort()).toEqual(['host', 'moved', 'workspace']);
  });

  it('refuses a workspace path that now holds another real directory', async () => {
    const pin = await pinWorkspace(workspace);
    await rename(workspace, join(scratch, 'moved'));
    await mkdir(workspace);
    expect(await codeOf(() => installClaudeArtifact(pin, skill))).toBe('workspace-replaced');
    expect(await readdir(workspace)).toEqual([]);
  });

  it('refuses a workspace whose ancestor was re-linked, and one that vanished', async () => {
    const parent = join(scratch, 'parent');
    await mkdir(join(parent, 'ws'), { recursive: true });
    const pin = await pinWorkspace(join(parent, 'ws'));
    await rename(parent, join(scratch, 'parent-moved'));
    await symlink(join(scratch, 'parent-moved'), parent);
    expect(await codeOf(() => installClaudeArtifact(pin, skill))).toBe('workspace-replaced');
    await rm(parent);
    await rm(join(scratch, 'parent-moved'), { recursive: true });
    expect(await codeOf(() => installClaudeArtifact(pin, skill))).toBe('workspace-replaced');
  });

  it('refuses a pin of a link', async () => {
    await symlink(workspace, join(scratch, 'alias'));
    await expect(pinWorkspace(join(scratch, 'alias'))).rejects.toThrow(/must be a real directory/);
  });
});

describe('claudeArtifactProfile', () => {
  it('returns the skill name for skill-md and the format otherwise', () => {
    expect(claudeArtifactProfile(skill)).toEqual({ format: 'skill-md', skillName: 'pdf' });
    expect(claudeArtifactProfile(bundle('claude-rule', { 'r.md': 'x' }))).toEqual({
      format: 'claude-rule',
    });
    expect(() => claudeArtifactProfile(bundle('cursor-rule', { 'r.mdc': 'x' }))).toThrow(
      /not compatible with adapter claude-code/,
    );
  });

  it('knows which formats are installable', () => {
    expect(isClaudeInstallableFormat('agents-md')).toBe(true);
    expect(isClaudeInstallableFormat('gitlab-duo-chat-rules')).toBe(false);
  });
});
