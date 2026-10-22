import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  CLAUDE_CODE_RUN_SETTINGS,
  claudeFlagsHash,
  ClaudeCodeError,
  normalizeClaudeArgv,
  type ClaudeArgvInput,
} from '../../src/claude-code';

const base: ClaudeArgvInput = {
  authMode: 'subscription',
  permissionProfile: 'edit-only',
  artifact: { format: 'claude-md' },
  model: null,
};

/** The values given to `--allowedTools`: every argument up to the next flag. */
function allowRules(argv: string[]): string[] {
  const start = argv.indexOf('--allowedTools') + 1;
  const end = argv.findIndex((argument, index) => index >= start && argument.startsWith('--'));
  return argv.slice(start, end);
}

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
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

describe('buildClaudeArgv', () => {
  it('builds the canonical edit-only argv of an instruction type in subscription mode', () => {
    expect(buildClaudeArgv(base)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      'Read,Edit,Write,Glob,Grep',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Edit(/**)',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--settings',
      '{"disableSkillShellExecution":true,"permissions":{"blockReadsOutsideWorkingDirectories":true}}',
      '--setting-sources',
      'project,local',
    ]);
  });

  it('adds Skill to the tools and allows only the installed skill for skill-md (FR-118-08)', () => {
    const argv = buildClaudeArgv({ ...base, artifact: { format: 'skill-md', skillName: 'pdf' } });
    expect(valueOf(argv, '--tools')).toBe('Read,Edit,Write,Glob,Grep,Skill');
    expect(allowRules(argv)).toEqual(['Edit(/**)', 'Skill(pdf)', 'Skill(pdf *)']);
  });

  it('gives instruction types no Skill tool and no Skill rule', () => {
    for (const format of ['claude-md', 'agents-md', 'claude-rule'] as const) {
      const argv = buildClaudeArgv({ ...base, artifact: { format } });
      expect(valueOf(argv, '--tools')).not.toContain('Skill');
      expect(allowRules(argv).some((rule) => rule.startsWith('Skill'))).toBe(false);
    }
  });

  it('adds Bash to tools and allow rules only for edit-and-shell', () => {
    const argv = buildClaudeArgv({
      ...base,
      permissionProfile: 'edit-and-shell',
      artifact: { format: 'skill-md', skillName: 'pdf' },
    });
    expect(valueOf(argv, '--tools')).toBe('Read,Edit,Write,Glob,Grep,Bash,Skill');
    expect(allowRules(argv)).toEqual(['Edit(/**)', 'Bash', 'Skill(pdf)', 'Skill(pdf *)']);
    expect(valueOf(buildClaudeArgv(base), '--tools')).not.toContain('Bash');
  });

  it('never allows a bare file tool, never widens the directories and never bypasses permissions (FR-118-07)', () => {
    for (const permissionProfile of ['edit-only', 'edit-and-shell'] as const) {
      for (const authMode of ['subscription', 'api-key'] as const) {
        const argv = buildClaudeArgv({
          ...base,
          authMode,
          permissionProfile,
          artifact: { format: 'skill-md', skillName: 'pdf' },
          model: { provider: 'anthropic', model: 'sonnet' },
          ...(authMode === 'api-key' ? { maxBudgetUsd: 1 } : {}),
        });
        const rules = allowRules(argv);
        for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) {
          expect(rules).not.toContain(tool);
        }
        expect(rules.filter((rule) => rule.startsWith('Edit'))).toEqual(['Edit(/**)']);
        for (const forbidden of [
          '--add-dir',
          '--fallback-model',
          '--bare',
          '--dangerously-skip-permissions',
          '--allow-dangerously-skip-permissions',
          'bypassPermissions',
          '--worktree',
          '--append-system-prompt',
        ]) {
          expect(argv).not.toContain(forbidden);
        }
        expect(valueOf(argv, '--permission-mode')).toBe('dontAsk');
        expect(JSON.parse(valueOf(argv, '--settings') as string)).toEqual(CLAUDE_CODE_RUN_SETTINGS);
        expect(CLAUDE_CODE_RUN_SETTINGS).toEqual({
          disableSkillShellExecution: true,
          permissions: { blockReadsOutsideWorkingDirectories: true },
        });
      }
    }
  });

  it('loads only project and local settings in subscription mode, every source in api-key mode', () => {
    expect(valueOf(buildClaudeArgv(base), '--setting-sources')).toBe('project,local');
    expect(buildClaudeArgv({ ...base, authMode: 'api-key' })).not.toContain('--setting-sources');
  });

  it('passes an Anthropic model and omits --model when none is set', () => {
    expect(buildClaudeArgv(base)).not.toContain('--model');
    const argv = buildClaudeArgv({
      ...base,
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5[1m]' },
    });
    expect(valueOf(argv, '--model')).toBe('claude-sonnet-4-5[1m]');
  });

  it('refuses a model of another provider and a model name that could be a flag', () => {
    expect(
      codeOf(() => buildClaudeArgv({ ...base, model: { provider: 'openai', model: 'gpt' } })),
    ).toBe('model-provider-unsupported');
    for (const model of ['--bare', '-p', 'a b', 'opus,sonnet', 'x'.repeat(201), 'mo\ndel']) {
      expect(
        codeOf(() => buildClaudeArgv({ ...base, model: { provider: 'anthropic', model } })),
        model,
      ).toBe('model-invalid');
    }
  });

  it('accepts a budget only in api-key mode and only as a positive finite number (FR-118-30)', () => {
    expect(
      valueOf(
        buildClaudeArgv({ ...base, authMode: 'api-key', maxBudgetUsd: 0.5 }),
        '--max-budget-usd',
      ),
    ).toBe('0.5');
    expect(codeOf(() => buildClaudeArgv({ ...base, maxBudgetUsd: 1 }))).toBe(
      'budget-requires-api-key',
    );
    for (const maxBudgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => buildClaudeArgv({ ...base, authMode: 'api-key', maxBudgetUsd }))).toBe(
        'budget-invalid',
      );
    }
  });

  it('refuses a skill name that would change the allow rules', () => {
    for (const skillName of [
      'pdf) Bash(',
      'pdf *',
      'a,b',
      'PDF',
      '',
      'a--b',
      '-a',
      'a'.repeat(65),
    ]) {
      expect(
        codeOf(() => buildClaudeArgv({ ...base, artifact: { format: 'skill-md', skillName } })),
        skillName,
      ).toBe('skill-name-unsupported');
    }
  });

  it('never carries a secret or a path, whatever the environment holds', () => {
    const argv = buildClaudeArgv({ ...base, authMode: 'api-key' });
    expect(argv.join(' ')).not.toMatch(/sk-ant|ANTHROPIC|\/home|\/tmp/);
  });
});

describe('claudeFlagsHash', () => {
  const skill = (skillName: string) =>
    buildClaudeArgv({ ...base, artifact: { format: 'skill-md', skillName } });

  it('is equal for two workspaces of one run (FR-118-04)', () => {
    const argv = skill('pdf');
    expect(
      claudeFlagsHash(argv, { skillName: 'pdf', runLocalPaths: ['/tmp/run/a', '/tmp/run/home-a'] }),
    ).toBe(
      claudeFlagsHash(argv, { skillName: 'pdf', runLocalPaths: ['/tmp/run/b', '/tmp/run/home-b'] }),
    );
  });

  it('replaces the installed skill name with a placeholder', () => {
    expect(normalizeClaudeArgv(skill('pdf'), { skillName: 'pdf' })).toContain('Skill(<skill> *)');
    expect(claudeFlagsHash(skill('pdf'), { skillName: 'pdf' })).toBe(
      claudeFlagsHash(skill('estimate'), { skillName: 'estimate' }),
    );
    expect(claudeFlagsHash(skill('pdf'), {})).not.toBe(claudeFlagsHash(skill('estimate'), {}));
  });

  it('differs when a flag differs', () => {
    expect(claudeFlagsHash(buildClaudeArgv(base), {})).not.toBe(
      claudeFlagsHash(buildClaudeArgv({ ...base, permissionProfile: 'edit-and-shell' }), {}),
    );
    expect(claudeFlagsHash(buildClaudeArgv(base), {})).not.toBe(
      claudeFlagsHash(buildClaudeArgv({ ...base, authMode: 'api-key' }), {}),
    );
  });

  it('replaces run-local paths inside arguments, longest first', () => {
    expect(
      normalizeClaudeArgv(['--x', '/w/a/b:/w/a', 'keep'], { runLocalPaths: ['/w/a', '/w/a/b'] }),
    ).toEqual(['--x', '<run-path>:<run-path>', 'keep']);
  });

  it('rejects an empty run-local path', () => {
    expect(() => normalizeClaudeArgv(['x'], { runLocalPaths: [''] })).toThrow(/must not be empty/);
  });
});
