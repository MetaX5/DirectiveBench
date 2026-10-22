import { parseFrontmatter, type ArtifactBundle } from '@directivebench/core';

/** Refusal codes of the artifact bundle inspection (SPEC-118 FR-118-26). */
export type ArtifactInspectionCode = 'artifact-executes-code' | 'artifact-overrides-model';

export interface ArtifactFinding {
  code: ArtifactInspectionCode;
  /** Which version of the run the finding is in. */
  role: 'candidate' | 'baseline';
  /** Bundle-relative path of the file. */
  file: string;
  detail: string;
}

/**
 * Path segments (any depth) whose presence in a bundle lets Claude Code load it as configuration:
 * nested `.claude/` directories load skills, commands and agents once Claude touches a file there,
 * and plugin manifests or hook directories register executable customizations (FR-118-26).
 */
const CONFIGURATION_SEGMENTS = new Set(['.claude', '.claude-plugin', 'hooks']);

/**
 * File names a bundle must not contain at any depth: FR-118-26's plugin, hook, MCP and settings
 * files, plus FR-118-06's other configuration surfaces (fail closed for bundles as for fixtures).
 */
const CONFIGURATION_FILES = new Set([
  'plugin.json',
  'hooks.json',
  '.mcp.json',
  'settings.json',
  'settings.local.json',
  'claude.local.md',
  '.worktreeinclude',
  '.claude.json',
]);

/**
 * A path segment as a case-insensitive file system resolves it: lowercased, without the trailing
 * dots and spaces Windows ignores. Comparing this form fails closed on macOS and Windows, where
 * `.Claude` is `.claude`.
 */
export function canonicalSegment(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/, (tail) => (tail === segment ? tail : ''));
}

/** Frontmatter key as compared here: lowercase, without `-` and `_` (`allowed_tools` too). */
function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function frontmatterFindings(content: string): Omit<ArtifactFinding, 'role' | 'file'>[] {
  const { frontmatter, error } = parseFrontmatter(content);
  if (error !== undefined) {
    return [
      {
        code: 'artifact-executes-code',
        detail: `the frontmatter cannot be parsed (${error}), so it cannot be checked`,
      },
    ];
  }
  const findings: Omit<ArtifactFinding, 'role' | 'file'>[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const name = canonicalKey(key);
    if (name === 'hooks') {
      findings.push({
        code: 'artifact-executes-code',
        detail: `frontmatter \`${key}\` registers hooks that run commands when the skill is invoked`,
      });
    } else if (name === 'allowedtools' && !isEmptyValue(value)) {
      findings.push({
        code: 'artifact-executes-code',
        detail: `frontmatter \`${key}\` grants tools; any grant can widen the permission profile`,
      });
    } else if (name === 'model' && value !== 'inherit') {
      findings.push({
        code: 'artifact-overrides-model',
        detail: `frontmatter \`${key}\` switches the model; only an absent model or \`inherit\` is allowed`,
      });
    } else if (
      name === 'context' &&
      typeof value === 'string' &&
      value.trim().toLowerCase() === 'fork'
    ) {
      findings.push({
        code: 'artifact-overrides-model',
        detail: `frontmatter \`${key}: fork\` runs the skill in a subagent on its own model`,
      });
    }
  }
  return findings;
}

/** A fence opening whose info string starts with `!` (a multi-line shell-injection block). */
const BANG_FENCE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*!/;

/**
 * Lines of SKILL.md that could run a command before the content reaches the model: any `` !` ``
 * sequence (fail closed, even in prose or code) and fences opened with `!`. One linear pass.
 */
function placeholderLines(content: string): number[] {
  const lines: number[] = [];
  content.split('\n').forEach((line, index) => {
    if (line.includes('!`') || BANG_FENCE.test(line)) lines.push(index + 1);
  });
  return lines;
}

/** Why a bundled path is Claude Code configuration, or null. */
function configurationPathReason(path: string): string | null {
  const segments = path.split('/').map(canonicalSegment);
  const file = segments.at(-1) as string;
  if (CONFIGURATION_FILES.has(file)) return 'a file Claude Code can load as configuration';
  if (segments.slice(0, -1).some((segment) => CONFIGURATION_SEGMENTS.has(segment))) {
    return 'a directory Claude Code can load configuration from';
  }
  return null;
}

/**
 * Executable customizations and model overrides in one stored artifact version (FR-118-26).
 * Every format is checked for bundled configuration files; a `skill-md` version's `SKILL.md`
 * additionally for frontmatter `hooks`, any non-empty `allowed-tools`, a `model` other than
 * `inherit`, `context: fork`, unparsable frontmatter and shell-injection placeholders. `@` imports
 * of host files are the import scan's job (FR-118-27).
 */
export function inspectArtifactBundle(
  artifact: ArtifactBundle,
  role: ArtifactFinding['role'],
): ArtifactFinding[] {
  const findings: ArtifactFinding[] = [];
  for (const file of artifact.files) {
    const reason = configurationPathReason(file.path);
    if (reason !== null) {
      findings.push({ code: 'artifact-executes-code', role, file: file.path, detail: reason });
    }
    if (artifact.format !== 'skill-md' || file.path !== 'SKILL.md') continue;
    for (const finding of frontmatterFindings(file.content)) {
      findings.push({ ...finding, role, file: file.path });
    }
    const lines = placeholderLines(file.content);
    if (lines.length > 0) {
      findings.push({
        code: 'artifact-executes-code',
        role,
        file: file.path,
        detail: `shell-injection placeholder (\`!\` + backtick) on line ${lines.join(', ')}`,
      });
    }
  }
  return findings;
}

/**
 * Inspects the candidate and, in an A/B run, the baseline version (FR-118-26): the run is refused
 * when any finding is returned ({@link artifactRefusalCode} names the code).
 */
export function inspectArtifactVersions(
  candidate: ArtifactBundle,
  baseline: ArtifactBundle | null,
): ArtifactFinding[] {
  return [
    ...inspectArtifactBundle(candidate, 'candidate'),
    ...(baseline === null ? [] : inspectArtifactBundle(baseline, 'baseline')),
  ];
}

/**
 * The code a refused run reports for these findings: `artifact-executes-code` when any finding has
 * it, else `artifact-overrides-model`; null when there is nothing to refuse.
 */
export function artifactRefusalCode(
  findings: readonly ArtifactFinding[],
): ArtifactInspectionCode | null {
  if (findings.length === 0) return null;
  return findings.some((finding) => finding.code === 'artifact-executes-code')
    ? 'artifact-executes-code'
    : 'artifact-overrides-model';
}
