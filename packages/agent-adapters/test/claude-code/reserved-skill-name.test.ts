import { describe, expect, it } from 'vitest';
import {
  assertClaudeSkillNameNotReserved,
  baselineSkillNameIssue,
  buildClaudeArgv,
  claudeArtifactProfile,
  ClaudeCodeError,
  CLAUDE_RESERVED_SKILL_NAMES,
  CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION,
  claudeSkillInstall,
} from '../../src/claude-code';
import { bundle } from './helpers';

// Issue 257 (SPEC-203 §4.1, SPEC-118 FR-118-08): a skill whose installed name equals a name
// Claude Code lists itself is refused before any `claude` process starts.

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ClaudeCodeError
      ? error.code
      : `not a ClaudeCodeError: ${String(error)}`;
  }
  return undefined;
}

function named(name: string, versionId = 'ver_1') {
  return bundle('skill-md', { 'SKILL.md': `---\nname: ${name}\n---\nBody.\n` }, { versionId });
}

describe('skill names Claude Code lists itself (issue 257)', () => {
  it('documents the claude version the list was observed for', () => {
    expect(CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION).toBe('2.1.302');
  });

  it('reserves the skills listed with bundled skills disabled and the built-in slash commands', () => {
    for (const name of ['design', 'doctor', 'plugin-authoring', 'checkup', 'compact', 'init']) {
      expect(CLAUDE_RESERVED_SKILL_NAMES.has(name), name).toBe(true);
    }
    // Bundled skills that `disableBundledSkills` removes are not listed in a run, so not reserved.
    for (const name of ['code-review', 'pdf', 'deep-research', 'simplify']) {
      expect(CLAUDE_RESERVED_SKILL_NAMES.has(name), name).toBe(false);
    }
  });

  it('holds only names that pass the skill-name form', () => {
    for (const name of CLAUDE_RESERVED_SKILL_NAMES) {
      expect(name, name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('refuses a reserved name with skill-name-reserved and names the claude version', () => {
    expect(codeOf(() => assertClaudeSkillNameNotReserved('doctor'))).toBe('skill-name-reserved');
    expect(() => assertClaudeSkillNameNotReserved('doctor')).toThrow(
      /"doctor" is a name Claude Code 2\.1\.302 lists itself/,
    );
    expect(codeOf(() => assertClaudeSkillNameNotReserved('pdf'))).toBeUndefined();
  });

  it('refuses a reserved frontmatter name and a reserved folder name alike', () => {
    expect(codeOf(() => claudeSkillInstall(named('doctor')))).toBe('skill-name-reserved');
    expect(codeOf(() => claudeArtifactProfile(named('design')))).toBe('skill-name-reserved');
    const nameless = bundle(
      'skill-md',
      { 'SKILL.md': '---\ndescription: d\n---\nBody.\n' },
      { slug: 'my-compact', folderName: 'compact' },
    );
    expect(codeOf(() => claudeSkillInstall(nameless))).toBe('skill-name-reserved');
  });

  it('checks the form first, so an invalid name keeps skill-name-unsupported', () => {
    expect(codeOf(() => claudeSkillInstall(named('Doctor')))).toBe('skill-name-unsupported');
  });

  it('refuses a reserved baseline name before comparing the two names', () => {
    expect(codeOf(() => baselineSkillNameIssue(named('pdf'), named('doctor', 'ver_0')))).toBe(
      'skill-name-reserved',
    );
  });

  it('refuses a reserved name in the argv builder too', () => {
    expect(
      codeOf(() =>
        buildClaudeArgv({
          authMode: 'subscription',
          permissionProfile: 'edit-only',
          artifact: { format: 'skill-md', skillName: 'plugin-authoring' },
          model: null,
        }),
      ),
    ).toBe('skill-name-reserved');
  });
});
