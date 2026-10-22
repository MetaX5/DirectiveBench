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
    return { frontmatter: {}, error: 'the frontmatter contains --- inside the block' };
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

/**
 * The name Claude Code resolves for an installed `skill-md` artifact (FR-118-08, SPEC-203 §4.1):
 * the `name` in the frontmatter of the bundle's `SKILL.md`, else (absent or null) the install
 * directory, which is the artifact slug. Fails closed with `skill-name-unsupported` when there is no `SKILL.md`, its
 * frontmatter cannot be parsed, `name` is not a string, or the name is not a valid skill name.
 */
export function claudeSkillName(artifact: ArtifactBundle): string {
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
  const name = declared ?? artifact.slug;
  assertClaudeSkillName(name);
  return name;
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
