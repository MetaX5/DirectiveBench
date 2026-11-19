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
import { bundle, fixture, recording325 } from './helpers';

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

interface InitNames {
  skills: string[];
  slash_commands: string[];
  terminal_slash_commands: string[];
}

/** The name lists of the recorded `system/init` (the first line). */
function initOf(stream: string): InitNames {
  const init = JSON.parse(stream.split('\n')[0] ?? '') as Partial<InitNames> & { subtype?: string };
  expect(init.subtype).toBe('init');
  return {
    skills: init.skills ?? [],
    slash_commands: init.slash_commands ?? [],
    terminal_slash_commands: init.terminal_slash_commands ?? [],
  };
}

const SKILL_NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The names a session start attributes to the CLI (issue 278): every entry of `skills`,
 * `slash_commands` and `terminal_slash_commands` except the skills the session installed, and
 * except names that are not valid skill names (`skill-name-unsupported` already refuses them).
 */
function cliOwnedNames(init: InitNames, installed: readonly string[]): string[] {
  const all = [...init.skills, ...init.slash_commands, ...init.terminal_slash_commands];
  return [...new Set(all)].filter(
    (name) => !installed.includes(name) && SKILL_NAME_FORM.test(name),
  );
}

describe('skill names Claude Code lists itself (issue 257)', () => {
  it('documents the claude version the list was last refreshed for', () => {
    expect(CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION).toBe('2.1.325');
  });

  // Issue 278: the next refresh is mechanical. Record a session start of the new version, add it
  // here and update the constant until these tests pass.
  it('covers every CLI-owned name the recorded 2.1.325 session start lists', () => {
    const init = initOf(recording325('live-subscription-reserved-doctor'));
    // The session installed a project skill named `doctor`; a colliding name is listed once
    // (issue 275), so that entry cannot be attributed to the CLI here (2.1.302 lists it).
    const owned = cliOwnedNames(init, ['doctor']);
    expect(owned).toContain('ultrareview');
    expect(owned.filter((name) => !CLAUDE_RESERVED_SKILL_NAMES.has(name))).toEqual([]);
  });

  it('covers every built-in slash command the recorded 2.1.302 session starts list', () => {
    for (const name of ['live-subscription-confine', 'live-subscription-slash']) {
      const init = initOf(fixture(name));
      // These sessions predate `disableBundledSkills`: their `skills` are bundled skills a run no
      // longer lists (not reserved), so only the slash commands that are not skills count.
      const builtIns = init.slash_commands.filter((entry) => !init.skills.includes(entry));
      const owned = cliOwnedNames({ ...init, skills: [], slash_commands: builtIns }, []);
      expect(
        owned.filter((entry) => !CLAUDE_RESERVED_SKILL_NAMES.has(entry)),
        name,
      ).toEqual([]);
    }
  });

  it('keeps the names the 2.1.325 recording does not attribute to the CLI', () => {
    // `doctor`: listed by 2.1.302 with bundled skills disabled; `checkup`: its unlisted alias.
    for (const name of ['doctor', 'checkup']) {
      expect(CLAUDE_RESERVED_SKILL_NAMES.has(name), name).toBe(true);
    }
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
      /"doctor" is a name Claude Code 2\.1\.325 lists itself/,
    );
    expect(codeOf(() => assertClaudeSkillNameNotReserved('ultrareview'))).toBe(
      'skill-name-reserved',
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
