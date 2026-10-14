import { describe, expect, it } from 'vitest';
import { classifyArtifactPath, parseArtifactFile, slugify } from '../src/artifacts';
import { parseFrontmatter } from '../src/frontmatter';

describe('classifyArtifactPath', () => {
  it.each([
    ['.claude/skills/pdf/SKILL.md', 'skill-md', 'skill', '.claude/skills/pdf'],
    ['.agents/skills/review/SKILL.md', 'skill-md', 'skill', '.agents/skills/review'],
    ['skills/x/SKILL.md', 'skill-md', 'skill', 'skills/x'],
    ['AGENTS.md', 'agents-md', 'instruction', null],
    ['packages/api/AGENTS.md', 'agents-md', 'instruction', null],
    ['CLAUDE.md', 'claude-md', 'instruction', null],
    ['.claude/rules/testing.md', 'claude-rule', 'rule', null],
    ['.github/copilot-instructions.md', 'copilot-instructions', 'instruction', null],
    ['.github/instructions/ts.instructions.md', 'copilot-path-instructions', 'rule', null],
    ['.cursor/rules/react.mdc', 'cursor-rule', 'rule', null],
    ['apps/web/.cursor/rules/nested/a.mdc', 'cursor-rule', 'rule', null],
    ['.gitlab/duo/chat-rules.md', 'gitlab-duo-chat-rules', 'rule', null],
  ])('%s → %s', (path, format, type, rootDir) => {
    expect(classifyArtifactPath(path)).toEqual({ format, type, rootDir });
  });

  it.each([
    'README.md',
    'docs/guide.md',
    '.github/instructions/readme.md',
    'skill.md',
    '.cursor/rules/a.md',
  ])('does not treat %s as an artifact', (path) => {
    expect(classifyArtifactPath(path)).toBeNull();
  });

  it('normalises Windows separators and leading ./', () => {
    expect(classifyArtifactPath('.\\.cursor\\rules\\a.mdc')?.format).toBe('cursor-rule');
  });
});

describe('parseArtifactFile', () => {
  it('parses SKILL.md frontmatter, activation and references', () => {
    const parsed = parseArtifactFile(
      '.agents/skills/validate/SKILL.md',
      '---\nname: validate-input\ndescription: Validate untrusted input.\n---\n# Title\nSee [ref](references/rules.md) and [web](https://example.com).\n',
    );
    expect(parsed).toMatchObject({
      type: 'skill',
      format: 'skill-md',
      name: 'validate-input',
      description: 'Validate untrusted input.',
      activation: { description: 'Validate untrusted input.' },
      references: ['references/rules.md'],
      warnings: [],
    });
  });

  it('falls back to the directory name and reports missing skill metadata', () => {
    const parsed = parseArtifactFile('.claude/skills/pdf-tools/SKILL.md', '# PDF tools\n');
    expect(parsed.name).toBe('pdf-tools');
    expect(parsed.description).toBe('PDF tools');
    expect(parsed.warnings).toHaveLength(2);
  });

  it('preserves Cursor rule globs and alwaysApply', () => {
    const parsed = parseArtifactFile(
      '.cursor/rules/react.mdc',
      '---\ndescription: React rules\nglobs: src/**/*.tsx, src/**/*.jsx\nalwaysApply: false\n---\nUse hooks.\n',
    );
    expect(parsed.activation).toEqual({
      description: 'React rules',
      globs: ['src/**/*.tsx', 'src/**/*.jsx'],
      alwaysApply: false,
    });
    expect(parsed.name).toBe('react');
  });

  it('maps Copilot applyTo to globs and warns when it is missing', () => {
    expect(
      parseArtifactFile(
        '.github/instructions/ts.instructions.md',
        '---\napplyTo: "**/*.ts"\n---\nx',
      ).activation.globs,
    ).toEqual(['**/*.ts']);
    expect(parseArtifactFile('.github/instructions/ts.instructions.md', 'x').warnings[0]).toMatch(
      /applyTo/,
    );
  });

  it('treats Claude rules without paths as always applied', () => {
    expect(parseArtifactFile('.claude/rules/a.md', 'x').activation).toEqual({ alwaysApply: true });
    expect(
      parseArtifactFile('.claude/rules/a.md', '---\npaths:\n  - "src/**"\n---\nx').activation,
    ).toEqual({ globs: ['src/**'] });
  });

  it('rejects unknown paths', () => {
    expect(() => parseArtifactFile('README.md', 'x')).toThrow(/Not a recognised/);
  });
});

describe('parseFrontmatter', () => {
  it('returns content unchanged without frontmatter', () => {
    expect(parseFrontmatter('# hi')).toEqual({ frontmatter: {}, body: '# hi' });
  });

  it('reports invalid YAML without throwing', () => {
    const result = parseFrontmatter('---\nname: [unclosed\n---\nbody');
    expect(result.error).toBeDefined();
    expect(result.body).toBe('body');
  });

  it('rejects non-mapping frontmatter', () => {
    expect(parseFrontmatter('---\n- a\n---\n').error).toMatch(/mapping/);
  });
});

describe('slugify', () => {
  it('creates URL-safe slugs', () => {
    expect(slugify('  Validate Ëxternal Input!  ')).toBe('validate-external-input');
    expect(slugify('!!!')).toBe('item');
  });
});
