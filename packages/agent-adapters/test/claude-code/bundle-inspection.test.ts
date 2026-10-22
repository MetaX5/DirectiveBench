import { describe, expect, it } from 'vitest';
import {
  artifactRefusalCode,
  baselineSkillNameIssue,
  canonicalSegment,
  claudeSkillName,
  ClaudeCodeError,
  inspectArtifactBundle,
  inspectArtifactVersions,
} from '../../src/claude-code';
import { bundle } from './helpers';

function skill(frontmatter: string, body = 'Do the task.\n', extra: Record<string, string> = {}) {
  return bundle('skill-md', { 'SKILL.md': `---\n${frontmatter}\n---\n${body}`, ...extra });
}

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

describe('claudeSkillName', () => {
  it('uses the frontmatter name, else the slug', () => {
    expect(claudeSkillName(skill('name: estimate-project'))).toBe('estimate-project');
    expect(claudeSkillName(skill('description: x'))).toBe('pdf');
    expect(claudeSkillName(skill('name:'))).toBe('pdf');
    expect(claudeSkillName(bundle('skill-md', { 'SKILL.md': 'No frontmatter.' }))).toBe('pdf');
  });

  it('fails closed on a missing SKILL.md, unparsable frontmatter, a non-string or invalid name', () => {
    expect(codeOf(() => claudeSkillName(bundle('skill-md', { 'docs/SKILL.md': 'x' })))).toBe(
      'skill-name-unsupported',
    );
    expect(codeOf(() => claudeSkillName(skill('name: [unclosed')))).toBe('skill-name-unsupported');
    expect(codeOf(() => claudeSkillName(skill('name: 12')))).toBe('skill-name-unsupported');
    expect(codeOf(() => claudeSkillName(skill('name: "pdf) Bash("')))).toBe(
      'skill-name-unsupported',
    );
    expect(codeOf(() => claudeSkillName(skill('name: My Skill')))).toBe('skill-name-unsupported');
  });
});

describe('baselineSkillNameIssue (FR-118-08)', () => {
  it('accepts two versions that resolve to the same name', () => {
    expect(baselineSkillNameIssue(skill('name: pdf'), skill('description: no name'))).toBeNull();
  });

  it('names both skills when they differ', () => {
    expect(baselineSkillNameIssue(skill('name: pdf-v2'), skill('name: pdf'))).toMatch(
      /"pdf" differs from the candidate's "pdf-v2"/,
    );
  });
});

describe('inspectArtifactBundle (FR-118-26)', () => {
  it('accepts a plain skill and instruction files', () => {
    expect(
      inspectArtifactBundle(
        skill(
          'name: pdf\ndescription: Fill PDFs.\nmodel: inherit\ncontext: default\nallowed-tools: []',
          undefined,
          {
            'scripts/fill.py': 'print(1)\n',
            'reference/CLAUDE.md': '# Notes\n',
            'docs/settings.md': 'not settings.json',
          },
        ),
        'candidate',
      ),
    ).toEqual([]);
    expect(
      inspectArtifactBundle(bundle('claude-md', { 'CLAUDE.md': 'Run !`ls` here' }), 'candidate'),
    ).toEqual([]);
  });

  it('refuses frontmatter hooks in any form', () => {
    for (const frontmatter of ['hooks:\n  PreToolUse: []', 'Hooks: {}', 'hooks: null']) {
      expect(inspectArtifactBundle(skill(frontmatter), 'candidate'), frontmatter).toEqual([
        expect.objectContaining({
          code: 'artifact-executes-code',
          role: 'candidate',
          file: 'SKILL.md',
        }),
      ]);
    }
  });

  it('refuses any non-empty allowed-tools, including grants inside the profile (AC-23)', () => {
    for (const value of [
      'Skill',
      'Skill(other-name)',
      'Edit',
      '[Read]',
      'Bash(git *)',
      '"  x  "',
    ]) {
      expect(inspectArtifactBundle(skill(`allowed-tools: ${value}`), 'candidate'), value).toEqual([
        expect.objectContaining({
          code: 'artifact-executes-code',
          detail: expect.stringMatching(/grants tools/),
        }),
      ]);
    }
    for (const value of ['{ Edit: true }', '3', 'true']) {
      expect(
        inspectArtifactBundle(skill(`allowed-tools: ${value}`), 'candidate'),
        value,
      ).toHaveLength(1);
    }
    for (const key of ['allowed_tools', 'allowedTools', 'Allowed-Tools']) {
      expect(inspectArtifactBundle(skill(`${key}: Edit`), 'candidate'), key).toHaveLength(1);
    }
    for (const empty of ["''", '[]', '', '"   "']) {
      expect(inspectArtifactBundle(skill(`allowed-tools: ${empty}`), 'candidate'), empty).toEqual(
        [],
      );
    }
  });

  it('refuses a model other than inherit and context: fork (AC-25)', () => {
    for (const value of ['opus', 'claude-haiku-4-5', 'Inherit', 'null', '""']) {
      expect(inspectArtifactBundle(skill(`model: ${value}`), 'baseline'), value).toEqual([
        expect.objectContaining({ code: 'artifact-overrides-model', role: 'baseline' }),
      ]);
    }
    for (const value of ['fork', 'Fork', ' fork ']) {
      expect(inspectArtifactBundle(skill(`context: "${value}"`), 'candidate'), value).toEqual([
        expect.objectContaining({
          code: 'artifact-overrides-model',
          detail: expect.stringMatching(/subagent/),
        }),
      ]);
    }
    expect(inspectArtifactBundle(skill('context: 3'), 'candidate')).toEqual([]);
  });

  it('reads frontmatter whose opening line has trailing blanks, as Claude Code does', () => {
    for (const opening of ['--- ', '---\t', '---  \t', '\uFEFF--- ']) {
      const findings = inspectArtifactBundle(
        bundle('skill-md', {
          'SKILL.md': `${opening}\nhooks:\n  Stop: []\nmodel: opus\n---\nbody`,
        }),
        'candidate',
      );
      expect(
        findings.map((finding) => finding.code),
        JSON.stringify(opening),
      ).toEqual(['artifact-executes-code', 'artifact-overrides-model']);
    }
    const crlf = bundle('skill-md', { 'SKILL.md': '--- \r\nallowed-tools: Bash\r\n---\r\nbody' });
    expect(inspectArtifactBundle(crlf, 'candidate')).toHaveLength(1);
    expect(
      claudeSkillName(bundle('skill-md', { 'SKILL.md': '--- \nname: real-name\n---\n' })),
    ).toBe('real-name');
  });

  it('fails closed on a SKILL.md that opens frontmatter but never closes it', () => {
    const open = bundle('skill-md', { 'SKILL.md': '---\nhooks: {}\nbody without a closing line' });
    expect(inspectArtifactBundle(open, 'candidate')).toEqual([
      expect.objectContaining({ detail: expect.stringMatching(/no closed frontmatter block/) }),
    ]);
    expect(codeOf(() => claudeSkillName(open))).toBe('skill-name-unsupported');
  });

  it('fails closed on --- inside the frontmatter block, where Claude Code may close it', () => {
    for (const frontmatter of ['description: a --- b', 'x: >\n  a\nmodel: opus---']) {
      expect(inspectArtifactBundle(skill(frontmatter), 'candidate'), frontmatter).toEqual([
        expect.objectContaining({ detail: expect.stringMatching(/--- inside the block/) }),
      ]);
    }
  });

  it('fails closed on frontmatter it cannot parse', () => {
    expect(inspectArtifactBundle(skill('name: [unclosed'), 'candidate')).toEqual([
      expect.objectContaining({
        code: 'artifact-executes-code',
        detail: expect.stringMatching(/cannot be parsed/),
      }),
    ]);
  });

  it('refuses any !` sequence in SKILL.md, in prose and code alike, and !-fences', () => {
    const findings = inspectArtifactBundle(
      skill(
        'name: pdf',
        'Prose with !`date` inline.\nok\n```\n!`ls`\n```\n  ```!\nmulti\n```\n~~~ !\nx\n~~~\n',
      ),
      'candidate',
    );
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'artifact-executes-code',
        detail: 'shell-injection placeholder (`!` + backtick) on line 4, 7, 9, 12',
      }),
    ]);
    expect(
      inspectArtifactBundle(skill('name: pdf', 'Say ! and `code` apart.\n'), 'candidate'),
    ).toEqual([]);
  });

  it('refuses bundled configuration files and nested .claude directories at any depth (AC-26)', () => {
    const paths = [
      '.claude/agents/helper.md',
      'nested/.claude/skills/x/SKILL.md',
      'deep/er/.Claude/commands/x.md',
      '.claude-plugin/plugin.json',
      'plugin.json',
      'hooks.json',
      'hooks/pre-tool.sh',
      'sub/hooks/x.sh',
      'config/.mcp.json',
      'settings.json',
      'x/settings.local.json',
      'CLAUDE.local.md',
      '.worktreeinclude',
      '.claude.json',
      '.CLAUDE./x.md',
    ];
    const findings = inspectArtifactBundle(
      skill('name: pdf', 'body\n', Object.fromEntries(paths.map((path) => [path, 'x']))),
      'candidate',
    );
    expect(findings.map((finding) => finding.file)).toEqual(paths);
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      new Set(['artifact-executes-code']),
    );
  });

  it('checks the baseline as well as the candidate', () => {
    const findings = inspectArtifactVersions(skill('name: pdf'), skill('name: pdf\nhooks: {}'));
    expect(findings).toEqual([
      expect.objectContaining({ role: 'baseline', code: 'artifact-executes-code' }),
    ]);
    expect(inspectArtifactVersions(skill('model: opus'), null)).toEqual([
      expect.objectContaining({ role: 'candidate' }),
    ]);
  });
});

describe('artifactRefusalCode', () => {
  it('prefers artifact-executes-code and returns null without findings', () => {
    expect(artifactRefusalCode([])).toBeNull();
    expect(artifactRefusalCode(inspectArtifactBundle(skill('model: opus'), 'candidate'))).toBe(
      'artifact-overrides-model',
    );
    expect(
      artifactRefusalCode(inspectArtifactBundle(skill('model: opus\nhooks: {}'), 'candidate')),
    ).toBe('artifact-executes-code');
  });
});

describe('canonicalSegment', () => {
  it('lowercases and drops trailing dots and spaces, but keeps . and ..', () => {
    expect(canonicalSegment('.Claude. ')).toBe('.claude');
    expect(canonicalSegment('..')).toBe('..');
    expect(canonicalSegment('.')).toBe('.');
    expect(canonicalSegment('Notes')).toBe('notes');
    expect(canonicalSegment('.mcp.jſon')).toBe('.mcp.json');
  });
});
