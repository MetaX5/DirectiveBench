import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ANCESTOR_CLAUDE_NAMES, inspectWorkspaceAncestors } from '../../src/claude-code';
import { pinWorkspace } from '../../src/workspace-pin';

const posix = describe.skipIf(process.platform === 'win32');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** `root/a/b/workspace`, pinned; `root` itself lies in the OS temp directory. */
async function nested() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-ancestors-')));
  roots.push(root);
  const workspaceDir = join(root, 'a', 'b', 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  return { root, workspace: await pinWorkspace(workspaceDir) };
}

posix('inspectWorkspaceAncestors', () => {
  it('passes when no ancestor holds Claude Code instructions or configuration', async () => {
    const { root, workspace } = await nested();
    expect(await inspectWorkspaceAncestors(workspace, join(root, 'home'))).toEqual([]);
  });

  it('refuses every loaded name in any ancestor, with a workspace-relative path', async () => {
    const { root, workspace } = await nested();
    for (const name of ANCESTOR_CLAUDE_NAMES) writeFileSync(join(root, 'a', name), 'x');
    mkdirSync(join(root, 'a', 'b', '.claude'));
    const findings = await inspectWorkspaceAncestors(workspace, join(root, 'home'));
    expect(findings.map((finding) => finding.path)).toEqual([
      '../.claude',
      ...ANCESTOR_CLAUDE_NAMES.map((name) => `../../${name}`),
    ]);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        code: 'workspace-contains-claude-config',
        detail:
          'Claude Code loads instructions or configuration from this ancestor of the workspace',
      });
    }
  });

  it("exempts only the agent HOME's own .claude and .claude.json", async () => {
    const { root, workspace } = await nested();
    const home = join(root, 'a');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(join(home, 'CLAUDE.md'), 'x');
    const findings = await inspectWorkspaceAncestors(workspace, home);
    expect(findings.map((finding) => finding.path)).toEqual(['../../CLAUDE.md']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails closed on an ancestor that cannot be checked',
    async () => {
      const { root, workspace } = await nested();
      chmodSync(join(root, 'a'), 0o600);
      try {
        const findings = await inspectWorkspaceAncestors(workspace, join(root, 'home'));
        expect(findings.length).toBeGreaterThan(0);
        expect(findings[0]?.detail).toMatch(/^cannot be checked \(EACCES\)/);
      } finally {
        chmodSync(join(root, 'a'), 0o700);
      }
    },
  );
});
