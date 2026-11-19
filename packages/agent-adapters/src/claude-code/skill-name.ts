import { parseFrontmatter, type ArtifactBundle } from '@directivebench/core';
import { ClaudeCodeError } from './errors';

/** The longest skill name Claude Code documents (lowercase letters, digits and hyphens). */
export const CLAUDE_SKILL_NAME_MAX_LENGTH = 64;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An opening frontmatter line with trailing blanks, which Claude Code accepts and core does not. */
const LOOSE_OPENING = /^\uFEFF?---[ \t]+(?=\r?\n)/;

/**
 * The frontmatter of a SKILL.md as Claude Code would see it, failing closed: an opening `---` line
 * with trailing spaces or tabs is accepted (Claude Code's own patterns allow them), and a file that
 * starts with `---` but yields no frontmatter block is reported as an `error`, never as empty.
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  error?: string;
} {
  const text = content.replace(LOOSE_OPENING, '---').replace(/^\uFEFF/, '');
  const parsed = parseFrontmatter(text);
  if (parsed.error !== undefined) return { frontmatter: {}, error: parsed.error };
  if (text.startsWith('---') && parsed.body === text) {
    return {
      frontmatter: {},
      error: 'the file starts with --- but has no closed frontmatter block',
    };
  }
  // Claude Code may also close the block at a `---` inside a line; any inner `---` fails closed.
  const block = text.slice(0, text.length - parsed.body.length);
  const inner = block.slice(block.indexOf('\n') + 1, block.lastIndexOf('---'));
  if (inner.includes('---')) {
    return {
      frontmatter: {},
      error:
        'the frontmatter contains --- inside the block, where Claude Code may end it; replace that ---',
    };
  }
  return { frontmatter: parsed.frontmatter };
}

/**
 * Throws `skill-name-unsupported` unless `name` has the documented skill-name form: lowercase
 * letters, digits and single hyphens, at most {@link CLAUDE_SKILL_NAME_MAX_LENGTH} characters. The
 * name goes into the allow rules `Skill(<name>)` and `Skill(<name> *)` (FR-118-08); a space,
 * comma, `*` or parenthesis would widen those rules, so anything else fails closed.
 */
export function assertClaudeSkillName(name: string): void {
  if (name.length > CLAUDE_SKILL_NAME_MAX_LENGTH || !SKILL_NAME.test(name)) {
    throw new ClaudeCodeError(
      'skill-name-unsupported',
      `The skill name ${JSON.stringify(name.slice(0, CLAUDE_SKILL_NAME_MAX_LENGTH + 1))} is not supported: use lowercase letters, digits and single hyphens, at most ${CLAUDE_SKILL_NAME_MAX_LENGTH} characters.`,
    );
  }
}

/** The newest `claude` version {@link CLAUDE_RESERVED_SKILL_NAMES} was refreshed for (SPEC-203 §4.1). */
export const CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION = '2.1.325';

/**
 * Names Claude Code lists itself, or answers to, in a run with DirectiveBench's settings, as
 * observed up to `claude` {@link CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION} (SPEC-203 §4.1 and §11,
 * issues 257 and 278). An installed skill under one of these names may shadow the CLI's own, or
 * be shadowed by it, so a benchmark could measure the wrong skill. The list is the union over the
 * observed versions, so an older supported `claude` keeps its names. Sources:
 * - `claude` 2.1.302, live check of 2026-10-26: the skills `system/init` still listed with
 *   `disableBundledSkills: true` (`design`, `doctor` and the built-in plugin's
 *   `plugin-authoring`) and the built-in slash commands, which are the `slash_commands` of the
 *   recorded `system/init` (`test/fixtures/claude-code/2.1.302/live-subscription-*.ndjson`) that
 *   are not in its `skills`;
 * - `claude` 2.1.325, live check of 2026-11-19 (issue 275, recording
 *   `test/fixtures/claude-code/2.1.325/live-subscription-reserved-doctor.ndjson`): every name of
 *   `skills`, `slash_commands` and `terminal_slash_commands` except the installed test skill
 *   `doctor`. It lists every 2.1.302 name above except `checkup`, plus `ultrareview`;
 * - `checkup`, the `/checkup` alias of `doctor` that neither `system/init` lists (issue 103 live
 *   check, `.ai/runs/2026-10-26-issue-103-live-check.md`; the stream parser already treats it as
 *   another skill).
 * `__remote-workflow`, listed by both versions, is left out: it is not a valid skill name, so
 * `skill-name-unsupported` already refuses it. Bundled skills that `disableBundledSkills` removes
 * are not listed in a run and not reserved. A newer `claude` may list other names:
 * `claudeSkillNameCollision` checks the session's own `system/init` after the spawn (issue 275).
 */
export const CLAUDE_RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  // Skills listed with `disableBundledSkills: true`.
  'design',
  'doctor',
  'plugin-authoring',
  // The unlisted `/checkup` alias of `doctor`.
  'checkup',
  // Built-in slash commands listed by 2.1.302 and 2.1.325.
  'advisor',
  'agents',
  'auto-mode-setup',
  'autocompact',
  'clear',
  'color',
  'compact',
  'config',
  'context',
  'design-consent',
  'design-revoke',
  'effort',
  'extra-usage',
  'fast',
  'focus',
  'goal',
  'heapdump',
  'import',
  'init',
  'insights',
  'list-agents',
  'mcp',
  'model',
  'output-style',
  'recap',
  'reload-plugins',
  'reload-skills',
  'rename',
  'security-review',
  'skill-doctor',
  'team-onboarding',
  'usage',
  'usage-credits',
  'workflow-launch-exec',
  // Built-in slash command first listed by 2.1.325 (issue 278).
  'ultrareview',
]);

/**
 * Throws `skill-name-reserved` when `name` is one Claude Code lists itself
 * ({@link CLAUDE_RESERVED_SKILL_NAMES}): which of the two a session would use is unknown.
 */
export function assertClaudeSkillNameNotReserved(name: string): void {
  if (CLAUDE_RESERVED_SKILL_NAMES.has(name)) {
    throw new ClaudeCodeError(
      'skill-name-reserved',
      `The skill name ${JSON.stringify(name)} is a name Claude Code ${CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION} lists itself (a skill or a built-in slash command), so the run could measure the CLI's own instead of the tested skill. Rename the skill (its frontmatter \`name\`, or its folder when it has none).`,
    );
  }
}

/** Where and under which name a `skill-md` artifact is installed (SPEC-203 §4.1). */
export interface ClaudeSkillInstall {
  /** The name Claude Code resolves: the frontmatter `name`, else the install directory. */
  name: string;
  /** The directory below `.claude/skills/`. */
  directory: string;
}

/**
 * The install directory and name of a `skill-md` artifact (FR-118-08, SPEC-203 §4.1, issue 245).
 * A `SKILL.md` that declares a `name` (not absent or null) is installed at `.claude/skills/<slug>/`
 * under that name. One that does not is installed in, and named after, the folder its repository's
 * own agent sees ({@link ArtifactBundle.folderName}), else the slug. Fails closed with
 * `skill-name-unsupported` when there is no `SKILL.md`, its frontmatter cannot be parsed, `name`
 * is not a string, or the resolved name is not a valid skill name: an invalid folder name such as
 * `Review_Tool` is refused, never replaced by the slug. A valid name Claude Code lists itself is
 * refused with `skill-name-reserved` (issue 257).
 */
export function claudeSkillInstall(artifact: ArtifactBundle): ClaudeSkillInstall {
  const skillFile = artifact.files.find((file) => file.path === 'SKILL.md');
  if (!skillFile) {
    throw new ClaudeCodeError(
      'skill-name-unsupported',
      'The skill version has no SKILL.md at its root.',
    );
  }
  const { frontmatter, error } = parseSkillFrontmatter(skillFile.content);
  if (error !== undefined) {
    throw new ClaudeCodeError(
      'skill-name-unsupported',
      `The SKILL.md frontmatter cannot be read: ${error}.`,
    );
  }
  const declared = frontmatter.name;
  if (declared !== undefined && declared !== null && typeof declared !== 'string') {
    throw new ClaudeCodeError(
      'skill-name-unsupported',
      'The SKILL.md frontmatter `name` is not a string.',
    );
  }
  const directory =
    declared === undefined || declared === null
      ? (artifact.folderName ?? artifact.slug)
      : artifact.slug;
  const name = declared ?? directory;
  assertClaudeSkillName(name);
  assertClaudeSkillNameNotReserved(name);
  return { name, directory };
}

/** The name Claude Code resolves for an installed `skill-md` artifact ({@link claudeSkillInstall}). */
export function claudeSkillName(artifact: ArtifactBundle): string {
  return claudeSkillInstall(artifact).name;
}

/**
 * Why the A/B baseline version cannot share one argv with the candidate, or null when it can: both
 * versions must resolve to the same skill name (FR-118-08, `baseline-skill-name-differs`). Both
 * names are resolved, so an unusable name in either version throws `skill-name-unsupported`.
 */
export function baselineSkillNameIssue(
  candidate: ArtifactBundle,
  baseline: ArtifactBundle,
): string | null {
  const candidateName = claudeSkillName(candidate);
  const baselineName = claudeSkillName(baseline);
  return candidateName === baselineName
    ? null
    : `The baseline version's skill name "${baselineName}" differs from the candidate's "${candidateName}"; both variants must allow the same skill.`;
}
