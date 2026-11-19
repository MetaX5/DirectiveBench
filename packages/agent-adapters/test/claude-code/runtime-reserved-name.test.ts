import { describe, expect, it } from 'vitest';
import {
  CLAUDE_RESERVED_SKILL_NAMES,
  claudeRunOutcome,
  claudeSkillNameCollision,
  parseClaudeStream,
  type ClaudeRunConditions,
} from '../../src/claude-code';
import { newerSessionStart, recording325, UNLISTED_BUILT_IN } from './helpers';

// Issue 275 (SPEC-203 §4.1, SPEC-118 FR-118-08): after the spawn, the skill name is compared with
// the session's own `system/init` `skills` and `slash_commands`. The recording comes from one real
// `claude` 2.1.325 session with a project skill named `doctor` installed (live check 2026-11-19).

const RECORDED = recording325('live-subscription-reserved-doctor');
const PROMPT = 'Reply with the single word OK.';

function conditions(overrides: Partial<ClaudeRunConditions> = {}): ClaudeRunConditions {
  return {
    adapterVersion: '2.1.325 (Claude Code)',
    authMode: 'subscription',
    permissionProfile: 'edit-only',
    requestedModel: 'haiku',
    flagsHash: 'hash',
    skill: true,
    ...overrides,
  };
}

function outcome(stream: string, skillName: string, overrides: Partial<ClaudeRunConditions> = {}) {
  const parsed = parseClaudeStream(stream, { skillName, prompt: PROMPT });
  return claudeRunOutcome(parsed, { exitCode: 0 }, conditions({ skillName, ...overrides }));
}

/** The recording with `name` added once more to the given `system/init` list. */
function listedTwice(name: string, list: 'skills' | 'slash_commands'): string {
  const [init, ...rest] = RECORDED.trimEnd().split('\n');
  const event = JSON.parse(init as string) as Record<string, string[]>;
  event[list] = [...(event[list] as string[]), name];
  return `${[JSON.stringify(event), ...rest].join('\n')}\n`;
}

describe('the recorded 2.1.325 session start with a colliding skill (issue 275 live check)', () => {
  it('lists the installed `doctor` exactly once in skills and once in slash_commands', () => {
    const parsed = parseClaudeStream(RECORDED, { skillName: 'doctor', prompt: PROMPT });
    expect(parsed.init?.skillNameEntries).toEqual({ skills: 1, slashCommands: 1 });
    expect(parsed.init?.model).toBe('claude-haiku-5-5');
    expect(parsed.result?.text).toBe('OK');
  });

  it('lists `ultrareview`, a built-in slash command the static list holds since issue 278', () => {
    expect(CLAUDE_RESERVED_SKILL_NAMES.has('ultrareview')).toBe(true);
    const parsed = parseClaudeStream(RECORDED, { skillName: 'ultrareview', prompt: PROMPT });
    expect(parsed.init?.skillNameEntries).toEqual({ skills: 0, slashCommands: 1 });
  });

  it('finds a built-in the static list misses in a newer session start', () => {
    expect(CLAUDE_RESERVED_SKILL_NAMES.has(UNLISTED_BUILT_IN)).toBe(false);
    const parsed = parseClaudeStream(newerSessionStart(), {
      skillName: UNLISTED_BUILT_IN,
      prompt: PROMPT,
    });
    expect(parsed.init?.skillNameEntries).toEqual({ skills: 0, slashCommands: 1 });
  });
});

describe('claudeSkillNameCollision and claudeRunOutcome (issue 275)', () => {
  it('cannot tell the CLI entry from the installed skill when listed once: no refusal', () => {
    for (const skillInstalled of [true, undefined]) {
      const result = outcome(
        RECORDED,
        'doctor',
        skillInstalled === undefined ? {} : { skillInstalled },
      );
      expect(result.status).toBe('completed');
      expect(result.errorCode).toBeUndefined();
      expect(result.error).toBeNull();
    }
  });

  it('ends a run that installed nothing infrastructure-error when the session lists the name', () => {
    const doctor = outcome(RECORDED, 'doctor', { skillInstalled: false });
    expect(doctor).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'skill-name-reserved',
    });
    expect(doctor.error).toBe(doctor.summary);
    expect(doctor.error).toContain(
      'Claude Code lists the skill name "doctor" itself: this agent run installed no skill, yet the session start (system/init) lists the name in skills and slash_commands.',
    );
    expect(doctor.error).toContain('Rename the skill');
    // Everything else the stream showed is kept.
    expect(doctor.metadata?.executionModel).toBe('claude-haiku-5-5');
    expect(doctor.usage).not.toBeNull();

    const ultrareview = outcome(RECORDED, 'ultrareview', { skillInstalled: false });
    expect(ultrareview.errorCode).toBe('skill-name-reserved');
    expect(ultrareview.error).toContain('lists the name in slash_commands.');
  });

  it('leaves a run that installed nothing alone when the session does not list the name', () => {
    const result = outcome(RECORDED, 'pdf', { skillInstalled: false });
    expect(result.status).toBe('completed');
    expect(result.errorCode).toBeUndefined();
  });

  it('fails closed on a name listed more than once while the skill is installed', () => {
    const skills = outcome(listedTwice('doctor', 'skills'), 'doctor', { skillInstalled: true });
    expect(skills).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'skill-name-reserved',
    });
    expect(skills.error).toContain(
      'Claude Code lists the skill name "doctor" more than once in the session start (system/init skills)',
    );
    const slash = outcome(listedTwice('doctor', 'slash_commands'), 'doctor');
    expect(slash.errorCode).toBe('skill-name-reserved');
    expect(slash.error).toContain('(system/init slash_commands)');
  });

  it('wins over the outcome the stream itself would have', () => {
    const parsed = parseClaudeStream(RECORDED, { skillName: 'doctor', prompt: PROMPT });
    const failed = claudeRunOutcome(
      parsed,
      { exitCode: 1 },
      conditions({ skillName: 'doctor', skillInstalled: false }),
    );
    expect(failed.status).toBe('infrastructure-error');
    expect(failed.errorCode).toBe('skill-name-reserved');
  });

  it('checks nothing without a skill name or a session start', () => {
    const parsed = parseClaudeStream(RECORDED, { prompt: PROMPT });
    expect(parsed.init?.skillNameEntries).toEqual({ skills: 0, slashCommands: 0 });
    expect(claudeSkillNameCollision(parsed, conditions({ skill: false }))).toBeNull();
    const noInit = parseClaudeStream(RECORDED.split('\n')[1] as string, {
      skillName: 'doctor',
      prompt: PROMPT,
    });
    expect(noInit.init).toBeNull();
    expect(
      claudeSkillNameCollision(noInit, conditions({ skillName: 'doctor', skillInstalled: false })),
    ).toBeNull();
  });
});
