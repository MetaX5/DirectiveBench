import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectWorkspace,
  isClaudeConfigPath,
  pinWorkspace,
  WORKSPACE_SCAN_MAX_BYTES,
  WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES,
  type WorkspaceFinding,
  type WorkspaceInspectionOptions,
} from '../../src/claude-code';
import { bundle, inspectPinned, installPinned } from './helpers';

/** Timeout for the heavier tests: they take well under a second alone, but CI runs every package on 2 cores. */
const LOADED_RUNNER_TIMEOUT_MS = 60_000;

let scratch: string;
let workspace: string;
let home: string;
let host: string;
let hostFile: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'db-claude-scan-')));
  workspace = join(scratch, 'workspace');
  home = join(scratch, 'home');
  host = join(scratch, 'host');
  hostFile = join(host, 'hostname');
  await mkdir(workspace);
  await mkdir(home);
  await mkdir(host);
  await writeFile(hostFile, 'host secret\n');
  await writeFile(join(home, 'planted.md'), 'planted\n');
});

afterEach(async () => {
  await chmod(join(workspace, 'locked'), 0o700).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(dirname(join(workspace, path)), { recursive: true });
  await writeFile(join(workspace, path), content);
}

function inspect(options: Partial<WorkspaceInspectionOptions> = {}) {
  return inspectPinned(workspace, { homeDir: home, ...options });
}

function summary(findings: WorkspaceFinding[]): string[] {
  return findings.map(
    (finding) => `${finding.code} ${finding.path}${finding.token ? ` ${finding.token}` : ''}`,
  );
}

describe('isClaudeConfigPath (FR-118-06)', () => {
  it('matches every configuration surface at any depth, case-insensitively', () => {
    for (const path of [
      '.claude/settings.json',
      '.claude',
      'sub/.claude/rules/x.md',
      'a/b/.claude-plugin/plugin.json',
      '.mcp.json',
      'deep/.mcp.json',
      'CLAUDE.local.md',
      'x/claude.LOCAL.md',
      '.worktreeinclude',
      '.claude.json',
      '.Claude/commands/x.md',
      '.claude./x',
      '.mcp.jſon',
      '.claude.jſon',
    ]) {
      expect(isClaudeConfigPath(path), path).toBe(true);
    }
  });

  it('allows instruction files and look-alikes', () => {
    for (const path of [
      'CLAUDE.md',
      'sub/AGENTS.md',
      'claude/x',
      '.claudex/y',
      'mcp.json',
      'docs/.claude.md',
    ]) {
      expect(isClaudeConfigPath(path), path).toBe(false);
    }
  });
});

describe('inspectWorkspace: Claude Code configuration (FR-118-06, AC-16, AC-26)', () => {
  it('accepts plain files, CLAUDE.md and AGENTS.md at any depth', async () => {
    await put('CLAUDE.md', '# Project\nSee @docs/context.md\n');
    await put('docs/context.md', 'Context, see @../README.md and @./more.md\n');
    await put('docs/more.md', 'more');
    await put('README.md', 'readme');
    await put('pkg/AGENTS.md', 'agents');
    await put('src/app.ts', "import x from '@/components/x';\nconst mail = 'a@b.c';\n");
    expect(await inspect()).toEqual([]);
  });

  it('refuses every configuration path, listing each one', async () => {
    await put('.claude/settings.local.json', '{"permissions":{"allow":["Skill"]}}');
    await put('sub/.claude/skills/x/SKILL.md', '---\nname: x\n---\n');
    await put('.mcp.json', '{}');
    await put('pkg/CLAUDE.local.md', 'x');
    expect(summary(await inspect({ claudeConfigCode: 'fixture-contains-claude-config' }))).toEqual([
      'fixture-contains-claude-config .claude',
      'fixture-contains-claude-config .claude/settings.local.json',
      'fixture-contains-claude-config .mcp.json',
      'fixture-contains-claude-config pkg/CLAUDE.local.md',
      'fixture-contains-claude-config sub/.claude',
      'fixture-contains-claude-config sub/.claude/skills',
      'fixture-contains-claude-config sub/.claude/skills/x',
      'fixture-contains-claude-config sub/.claude/skills/x/SKILL.md',
    ]);
  });

  it('exempts only the installed artifact before a spawn, not configuration a setup command added', async () => {
    const skill = bundle('skill-md', {
      'SKILL.md': '---\nname: pdf\n---\nBody\n',
      'ref/a.md': 'a',
    });
    const installed = await installPinned(workspace, skill);
    expect(await inspect({ installedPaths: installed.paths })).toEqual([]);
    await put('.claude/settings.local.json', '{}');
    await put('.claude/skills/pdf/extra.md', 'added by setup');
    expect(summary(await inspect({ installedPaths: installed.paths }))).toEqual([
      'workspace-contains-claude-config .claude/settings.local.json',
      'workspace-contains-claude-config .claude/skills/pdf/extra.md',
    ]);
  });

  it('does not exempt an installed path whose kind changed', async () => {
    await put('.claude/skills/pdf/SKILL.md/inner', 'x');
    expect(summary(await inspect({ installedPaths: ['.claude/skills/pdf/SKILL.md'] }))).toEqual([
      'workspace-contains-claude-config .claude/skills/pdf/SKILL.md',
      'workspace-contains-claude-config .claude/skills/pdf/SKILL.md/inner',
    ]);
  });

  it('fails closed on a directory it cannot list', async () => {
    if (process.getuid?.() === 0) return; // root reads every directory
    await put('locked/inner.md', 'x');
    await chmod(join(workspace, 'locked'), 0o000);
    expect(summary(await inspect())).toEqual(['workspace-contains-claude-config locked']);
  });

  it('fails closed on a workspace root it cannot list', async () => {
    if (process.getuid?.() === 0) return; // root reads every directory
    await chmod(workspace, 0o000);
    try {
      expect(summary(await inspect())).toEqual(['workspace-contains-claude-config .']);
    } finally {
      await chmod(workspace, 0o700);
    }
  });

  it('refuses a workspace that is not a directory', async () => {
    await expect(inspectPinned(hostFile, { homeDir: home })).rejects.toThrow(/real directory/);
  });

  it('refuses to inspect a workspace replaced by a link to a host directory (SPEC-118 §12)', async () => {
    const pin = await pinWorkspace(workspace);
    await rename(workspace, join(scratch, 'moved'));
    await symlink(host, workspace);
    expect(await inspectWorkspace(pin, { homeDir: home })).toEqual([
      expect.objectContaining({ code: 'workspace-replaced', path: '.' }),
    ]);
    await rm(workspace);
    await mkdir(workspace);
    expect(summary(await inspectWorkspace(pin, { homeDir: home }))).toEqual([
      'workspace-replaced .',
    ]);
  });
});

describe('inspectWorkspace: imports and links (FR-118-27, AC-27)', () => {
  it('(a) refuses a chain of workspace files ending in a host file, absolute or ~', async () => {
    await put('CLAUDE.md', '@docs/context.md\n');
    await put('docs/context.md', `Load @${hostFile} and @~/planted.md please.\n`);
    const findings = await inspect();
    expect(summary(findings)).toEqual([
      `workspace-imports-outside docs/context.md ${hostFile}`,
      'workspace-imports-outside docs/context.md ~/planted.md',
    ]);
    expect(findings[0]).toMatchObject({ target: hostFile });
    expect(findings[1]).toMatchObject({ target: join(home, 'planted.md') });
  });

  it('resolves ~ against the agent home of the auth mode', async () => {
    await put('CLAUDE.md', '@~/planted.md\n');
    expect(await inspect({ homeDir: host })).toEqual([]);
  });

  it('(b) refuses an import inside a file of the installed artifact (no exemption)', async () => {
    const skill = bundle('skill-md', {
      'SKILL.md': '---\nname: pdf\n---\nBody\n',
      'reference/CLAUDE.md': `@${hostFile}\n`,
    });
    const installed = await installPinned(workspace, skill);
    expect(summary(await inspect({ installedPaths: installed.paths }))).toEqual([
      `workspace-imports-outside .claude/skills/pdf/reference/CLAUDE.md ${hostFile}`,
    ]);
  });

  it('(c) refuses a symbolic link to a host file or directory and a dangling link', async () => {
    await symlink(hostFile, join(workspace, 'link-file'));
    await symlink(host, join(workspace, 'link-dir'));
    await symlink(join(scratch, 'missing'), join(workspace, 'dangling'));
    await put('CLAUDE.md', '@link-file\n');
    const findings = await inspect();
    expect(summary(findings)).toEqual([
      `workspace-imports-outside dangling ${join(scratch, 'missing')}`,
      `workspace-imports-outside link-dir ${host}`,
      `workspace-imports-outside link-file ${hostFile}`,
    ]);
    expect(findings[0]?.detail).toMatch(/cannot be resolved/);
    expect(findings[1]).toMatchObject({ target: host });
  });

  it('(d) refuses an import inside a fenced code block', async () => {
    await put('notes.md', `\`\`\`\n@${hostFile}\n\`\`\`\n`);
    expect(summary(await inspect())).toEqual([`workspace-imports-outside notes.md ${hostFile}`]);
  });

  it('refuses a relative import that climbs out to an existing file, physically or lexically', async () => {
    await put('a/b/CLAUDE.md', '@../../../host/hostname\n');
    expect(summary(await inspect())).toEqual([
      'workspace-imports-outside a/b/CLAUDE.md ../../../host/hostname',
    ]);
  });

  it('also resolves .. from the workspace path as given, not only the canonical one', async () => {
    // The run uses links/alias/workspace, where links/alias is a link to the scratch directory.
    await mkdir(join(scratch, 'links'));
    await symlink(scratch, join(scratch, 'links', 'alias'));
    await writeFile(join(scratch, 'links', 'planted.md'), 'planted');
    await put('CLAUDE.md', '@../../planted.md\n');
    expect(await inspect()).toEqual([]);
    const findings = await inspectPinned(join(scratch, 'links', 'alias', 'workspace'), {
      homeDir: home,
    });
    expect(summary(findings)).toEqual(['workspace-imports-outside CLAUDE.md ../../planted.md']);
    expect(findings[0]?.target).toBe(join(scratch, 'links', 'planted.md'));
  });

  it('passes non-existent outside targets and inside imports', async () => {
    await put(
      'CLAUDE.md',
      '@/components/x @~/missing.md @../not-there @docs/a.md @./docs/../docs/a.md\n',
    );
    await put('docs/a.md', 'a');
    expect(await inspect()).toEqual([]);
  });

  it('passes links that stay inside the workspace', async () => {
    await put('docs/a.md', `@${join(workspace, 'docs')}/a.md\n`);
    await symlink('docs/a.md', join(workspace, 'alias.md'));
    await symlink('docs', join(workspace, 'docs-alias'));
    expect(await inspect()).toEqual([]);
  });

  it('refuses a climbing relative import when a link could expose the file at another depth', async () => {
    await put('deep/dir/CLAUDE.md', '@../sibling.md\n');
    await put('deep/sibling.md', 's');
    expect(await inspect()).toEqual([]);
    await symlink('deep/dir/CLAUDE.md', join(workspace, 'shallow.md'));
    const findings = await inspect();
    expect(summary(findings)).toEqual([
      'workspace-imports-outside deep/dir/CLAUDE.md ../sibling.md',
    ]);
    expect(findings[0]?.detail).toMatch(/symbolic links/);
  });

  it('cuts a long token in the finding to 200 characters', async () => {
    const deep = join(host, 'd'.repeat(150), 'e'.repeat(150));
    await mkdir(dirname(deep), { recursive: true });
    await writeFile(deep, 'x');
    await put('CLAUDE.md', `@${deep}\n`);
    const [finding] = await inspect();
    expect(finding?.token).toBe(`${deep.slice(0, 200)}…`);
    expect(finding?.target).toBe(deep);
  });

  it('reports one finding per token and file', async () => {
    await put('CLAUDE.md', `@${hostFile} @${hostFile}. @${hostFile}\n`);
    expect(summary(await inspect())).toEqual([`workspace-imports-outside CLAUDE.md ${hostFile}`]);
  });

  it('refuses a hard-linked file and a special file', async () => {
    await link(hostFile, join(workspace, 'hard.md'));
    execFileSync('mkfifo', [join(workspace, 'pipe')]);
    const findings = await inspect();
    expect(summary(findings)).toEqual([
      'workspace-imports-outside hard.md',
      'workspace-imports-outside pipe',
    ]);
    expect(findings[1]?.detail).toMatch(/not a regular file/);
  });

  it('fails closed on a file it cannot read and a target whose existence is unknown', async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    await put('secret.md', 'x');
    await chmod(join(workspace, 'secret.md'), 0o000);
    await mkdir(join(scratch, 'sealed'));
    await put('CLAUDE.md', `@${join(scratch, 'sealed', 'x')}\n`);
    await chmod(join(scratch, 'sealed'), 0o000);
    try {
      const findings = await inspect();
      expect(summary(findings)).toEqual([
        `workspace-imports-outside CLAUDE.md ${join(scratch, 'sealed', 'x')}`,
        'workspace-imports-outside secret.md',
      ]);
      expect(findings[0]?.detail).toMatch(/cannot be determined \(EACCES\)/);
      expect(findings[1]?.detail).toMatch(/cannot be read \(EACCES\)/);
    } finally {
      await chmod(join(scratch, 'sealed'), 0o700);
      await chmod(join(workspace, 'secret.md'), 0o600);
    }
  });
});

describe('inspectWorkspace: limits (FR-118-27)', () => {
  it(`refuses more than ${WORKSPACE_SCAN_MAX_BYTES} bytes before reading them`, async () => {
    const handle = await open(join(workspace, 'sparse.bin'), 'w');
    await handle.truncate(WORKSPACE_SCAN_MAX_BYTES + 1);
    await handle.close();
    const findings = await inspect();
    expect(summary(findings)).toEqual(['workspace-scan-limit .']);
    expect(findings[0]?.detail).toMatch(/bytes/);
  });

  it(
    `refuses more than ${WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES} import candidates`,
    async () => {
      // About 0.3 s alone; the timeout allows for a 2-core CI runner shared with every package.
      await put('many.md', '@/x '.repeat(WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES + 1));
      const findings = await inspect();
      expect(summary(findings)).toEqual(['workspace-scan-limit .']);
      expect(findings[0]?.detail).toMatch(/import tokens/);
    },
    LOADED_RUNNER_TIMEOUT_MS,
  );

  it('refuses an over-long token that normalising could shorten', async () => {
    await put('long.md', `@/${'a/'.repeat(3000)}../../etc/hostname`);
    const findings = await inspect();
    expect(summary(findings)).toEqual(['workspace-scan-limit .']);
    expect(findings[0]?.detail).toMatch(/long\.md/);
  });

  it(
    'scans in time linear in the workspace size',
    async () => {
      const fill = async (dir: string, files: number) => {
        await mkdir(join(workspace, dir));
        const line = `See @docs/a.md, mail a@b.c, @/nope/${dir} and @${'@'.repeat(50)}x\n`;
        await Promise.all(
          Array.from({ length: files }, (_, index) =>
            writeFile(join(workspace, dir, `f${index}.md`), line.repeat(100)),
          ),
        );
      };
      // Fastest of three runs, so a busy runner slows a run down but cannot fake a ratio.
      const time = async (dir: string) => {
        let fastest = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run += 1) {
          const started = performance.now();
          await inspectPinned(join(workspace, dir), { homeDir: home });
          fastest = Math.min(fastest, performance.now() - started);
        }
        return Math.max(fastest, 1);
      };
      await fill('small', 25);
      await fill('large', 100);
      const small = await time('small');
      const large = await time('large');
      // Linear: about 4×; the bound is wide for a loaded runner (quadratic would be 16×).
      expect(large / small).toBeLessThan(12);
    },
    LOADED_RUNNER_TIMEOUT_MS,
  );
});
