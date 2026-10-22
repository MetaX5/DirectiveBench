import { canonicalJson, sha256, type ModelSelection } from '@directivebench/core';
import { ClaudeCodeError } from './errors';
import { assertClaudeSkillName } from './skill-name';

/** How the agent process authenticates (SPEC-118 FR-118-02; gateway and cloud modes are not in S1). */
export type ClaudeAuthMode = 'subscription' | 'api-key';

/** What the agent may do (SPEC-203 §7); `edit-and-shell` only for execution-approved suites. */
export type ClaudePermissionProfile = 'edit-only' | 'edit-and-shell';

/**
 * The artifact a run measures, which decides the per-type profile (SPEC-203 §7, FR-118-08): a skill
 * needs the `Skill` tool, allowed only for its resolved name; instruction types load without it.
 */
export type ClaudeArtifactProfile =
  { format: 'skill-md'; skillName: string } | { format: 'claude-md' | 'agents-md' | 'claude-rule' };

export interface ClaudeArgvInput {
  authMode: ClaudeAuthMode;
  permissionProfile: ClaudePermissionProfile;
  artifact: ClaudeArtifactProfile;
  /** `execution.model`; null leaves the model to the CLI default (`--model` omitted). */
  model: ModelSelection | null;
  /** `--max-budget-usd`, API Key Mode only (FR-118-30). */
  maxBudgetUsd?: number;
}

/**
 * Settings passed with `--settings` on every run: skill shell-injection placeholders are disabled
 * (FR-118-26, second line of defence) and the file tools refuse paths outside the working
 * directory in every mode (FR-118-07).
 */
export const CLAUDE_CODE_RUN_SETTINGS = {
  disableSkillShellExecution: true,
  permissions: { blockReadsOutsideWorkingDirectories: true },
} as const;

/**
 * The only allow rule for file tools: `Edit(/**)` is anchored at the primary working directory
 * (the workspace) and also governs `Write`; reads inside the workspace need no rule (FR-118-07). A
 * bare `Read`/`Edit`/`Write`/`Glob`/`Grep` rule would approve every path and is never emitted.
 */
export const CLAUDE_CODE_EDIT_RULE = 'Edit(/**)';

/** Fixed stand-in for the installed skill's name in the normalised argv (FR-118-04). */
export const FLAGS_HASH_SKILL_PLACEHOLDER = '<skill>';

/** Fixed stand-in for a run-local path (workspace, isolated home, temp directory) (FR-118-04). */
export const FLAGS_HASH_PATH_PLACEHOLDER = '<run-path>';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;

function toolsFor(input: ClaudeArgvInput): string[] {
  const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
  if (input.permissionProfile === 'edit-and-shell') tools.push('Bash');
  if (input.artifact.format === 'skill-md') tools.push('Skill');
  return tools;
}

function skillRules(skillName: string): [string, string] {
  return [`Skill(${skillName})`, `Skill(${skillName} *)`];
}

function allowRulesFor(input: ClaudeArgvInput): string[] {
  const rules = [CLAUDE_CODE_EDIT_RULE];
  if (input.permissionProfile === 'edit-and-shell') rules.push('Bash');
  if (input.artifact.format === 'skill-md') rules.push(...skillRules(input.artifact.skillName));
  return rules;
}

function modelArgs(model: ModelSelection | null): string[] {
  if (model === null) return [];
  if (model.provider !== 'anthropic') {
    throw new ClaudeCodeError(
      'model-provider-unsupported',
      `Claude Code runs Anthropic models only; the benchmark asks for provider "${model.provider}".`,
    );
  }
  if (!MODEL_NAME.test(model.model)) {
    throw new ClaudeCodeError(
      'model-invalid',
      'The model name must start with a letter or digit and contain only letters, digits and . _ : @ / [ ] -.',
    );
  }
  return ['--model', model.model];
}

function budgetArgs(input: ClaudeArgvInput): string[] {
  if (input.maxBudgetUsd === undefined) return [];
  if (input.authMode !== 'api-key') {
    throw new ClaudeCodeError(
      'budget-requires-api-key',
      'A budget cap (--max-budget-usd) is enforced only in API Key Mode.',
    );
  }
  if (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0) {
    throw new ClaudeCodeError('budget-invalid', 'The budget cap must be a positive number.');
  }
  return ['--max-budget-usd', String(input.maxBudgetUsd)];
}

/**
 * The argv (without the executable) of one `claude` agent run, SPEC-203 §6/§7 with SPEC-118
 * FR-118-07/08/26: print mode with `stream-json`, the permission profile in its per-artifact-type
 * form under `dontAsk`, no MCP servers, no session persistence, the run settings, and in Local
 * Subscription Mode only the project and local setting sources. The prompt goes on stdin, never in
 * argv; no secret, path, `--add-dir`, `--fallback-model`, `--bare` or permission bypass is ever
 * emitted. Both variants of a run get the same argv: in a run without an A/B baseline the baseline
 * still allows the (not installed) skill.
 */
export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  if (input.artifact.format === 'skill-md') assertClaudeSkillName(input.artifact.skillName);
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...modelArgs(input.model),
    '--tools',
    toolsFor(input).join(','),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ...allowRulesFor(input),
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--settings',
    JSON.stringify(CLAUDE_CODE_RUN_SETTINGS),
    ...(input.authMode === 'subscription' ? ['--setting-sources', 'project,local'] : []),
    ...budgetArgs(input),
  ];
}

export interface FlagsHashSubstitutions {
  /** The installed skill's resolved name; its `Skill(…)` rules become the placeholder. */
  skillName?: string;
  /** Run-local absolute paths (workspace, isolated home, temp directories). */
  runLocalPaths?: readonly string[];
}

/**
 * The argv normalised for the flags hash (FR-118-04): the `Skill(<name>)` and `Skill(<name> *)`
 * rules name {@link FLAGS_HASH_SKILL_PLACEHOLDER} and every occurrence of a run-local path is
 * {@link FLAGS_HASH_PATH_PLACEHOLDER} (longest path first, so a path inside another is not split).
 * The prompt is never in argv. An empty run-local path is rejected: it would match everywhere.
 */
export function normalizeClaudeArgv(
  argv: readonly string[],
  substitutions: FlagsHashSubstitutions,
): string[] {
  const paths = [...(substitutions.runLocalPaths ?? [])].sort((a, b) => b.length - a.length);
  if (paths.some((path) => path === '')) {
    throw new Error('A run-local path for the flags hash must not be empty.');
  }
  const skill = substitutions.skillName;
  const [exact, wildcard] = skill === undefined ? [null, null] : skillRules(skill);
  const [exactPlaceholder, wildcardPlaceholder] = skillRules(FLAGS_HASH_SKILL_PLACEHOLDER);
  return argv.map((argument) => {
    if (argument === exact) return exactPlaceholder;
    if (argument === wildcard) return wildcardPlaceholder;
    return paths.reduce(
      (text, path) => text.split(path).join(FLAGS_HASH_PATH_PLACEHOLDER),
      argument,
    );
  });
}

/**
 * `flagsHash` of the adapter metadata (FR-118-04): sha256 of the normalised argv as a JSON array,
 * so two workspaces of one run, and two runs of skills with different names under otherwise equal
 * conditions, hash equally.
 */
export function claudeFlagsHash(
  argv: readonly string[],
  substitutions: FlagsHashSubstitutions,
): string {
  return sha256(canonicalJson(normalizeClaudeArgv(argv, substitutions)));
}
