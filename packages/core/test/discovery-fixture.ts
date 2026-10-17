import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SKILL =
  '---\nname: validate-external-input\ndescription: Validate untrusted input at boundaries.\n---\n# Validate\nSee [API](references/api.md).\n';

/**
 * Builds the SPEC-102 §15 discovery fixture: every supported format, decoy Markdown files, a
 * nested skill, binary and non-UTF-8 supporting files, symlinks, skipped directories and an
 * executable script that would create `<outside>/executed.marker` if it were ever run.
 * Symlinks point into `outside`, a directory that is not below `root`.
 */
export async function buildDiscoveryFixture(root: string, outside: string): Promise<void> {
  const files: Record<string, string | Uint8Array> = {
    '.agents/skills/validate/SKILL.md': SKILL,
    '.agents/skills/validate/scripts/run.sh': `#!/bin/sh\ntouch "${join(outside, 'executed.marker')}"\n`,
    '.agents/skills/validate/references/api.md': '# API\n',
    '.agents/skills/validate/assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]),
    '.agents/skills/validate/assets/latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    '.agents/skills/validate/nested/SKILL.md': '---\nname: nested\ndescription: Nested.\n---\n',
    '.agents/skills/validate/nested/extra.md': 'extra\n',
    'AGENTS.md': '# Repository rules\n',
    'packages/api/AGENTS.md': '# API rules\n',
    'CLAUDE.md': '# Claude rules\n',
    '.cursor/rules/react.mdc': '---\nglobs: "src/**/*.tsx"\nalwaysApply: false\n---\n# React\n',
    '.github/copilot-instructions.md': '# Copilot\n',
    '.github/instructions/php.instructions.md': '# PHP\n',
    '.claude/rules/style.md': '# Style\n',
    '.gitlab/duo/chat-rules.md': '# Duo\n',
    // Decoys: not artifacts (SPEC-102 §8.2).
    'README.md': '# Readme\n',
    'docs/guide.md': '# Guide\n',
    'docs/skill.md': '# wrong case\n',
    '.github/README.md': '# GitHub readme\n',
    '.cursorrules': 'legacy\n',
    'src/rules/x.mdc': 'not a cursor rule\n',
    // Skipped directories.
    '.git/AGENTS.md': '# inside .git\n',
    'node_modules/pkg/SKILL.md': SKILL,
  };
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await chmod(join(root, '.agents/skills/validate/scripts/run.sh'), 0o755);

  await writeFile(join(outside, 'secret.md'), 'outside the root\n');
  await writeFile(join(outside, 'CLAUDE.md'), '# outside\n');
  await symlink(join(outside, 'secret.md'), join(root, '.agents/skills/validate/link.md'));
  await mkdir(join(root, 'linked'));
  await symlink(join(outside, 'CLAUDE.md'), join(root, 'linked/CLAUDE.md'));
}
