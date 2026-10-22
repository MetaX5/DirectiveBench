import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CLAUDE_AUTH_MODES,
  CLAUDE_CODE_ADAPTER_ID,
  ClaudeCodeError,
  artifactRefusalCode,
  baselineSkillNameIssue,
  checkClaudeCodeReadiness,
  claudeArtifactProfile,
  claudeModelArgs,
  claudeCodeCaseOptionsSchema,
  inspectArtifactVersions,
  inspectWorkspace,
  installClaudeArtifact,
  parseSkillFrontmatter,
  pinWorkspace,
  type ClaudeAuthMode,
  type ClaudeCodeReadinessReport,
  type WorkspaceFinding,
} from '@directivebench/agent-adapters';
import {
  copyTree,
  definitionRunsCommands,
  executionBlockers,
  prepareSuiteImport,
  type PreparedSuite,
} from '@directivebench/benchmark-engine';
import { baselineArtifactIssue, type ArtifactBundle } from '@directivebench/core';
import {
  getArtifactBundle,
  resolveArtifactRef,
  suiteVersionApproval,
  type Database,
  type ResolvedArtifactRef,
} from '@directivebench/database';
import { artifactRefCliError } from './benchmark-init';
import { CliError, ExitCode } from './runtime';

/** Findings named in a plan-time refusal; the rest are counted (the run is refused either way). */
export const PLAN_FINDINGS_SHOWN = 20;

export interface BenchmarkRunFlags {
  dataDir?: string;
  suite: string;
  artifact: string;
  version?: string;
  baseline?: string;
  auth?: string;
  maxBudgetUsd?: string;
  approveCommands?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface RunOptions {
  suitePath: string;
  artifact: string;
  version: number | undefined;
  /** Version number of the A/B baseline, or null for baseline kind `none`. */
  baselineVersion: number | null;
  authMode: ClaudeAuthMode;
  maxBudgetUsd: number | undefined;
  approveCommands: boolean;
  yes: boolean;
  json: boolean;
}

function usage(message: string): CliError {
  return new CliError(message, ExitCode.Usage);
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d{0,8}$/.test(value)) throw usage(`${flag} expects a version number such as 3.`);
  return Number(value);
}

/** Validates the flags of `benchmark run` (SPEC-118 FR-118-30) before anything is read. */
export function parseRunFlags(flags: BenchmarkRunFlags): RunOptions {
  const auth = flags.auth ?? 'subscription';
  if (!(CLAUDE_AUTH_MODES as readonly string[]).includes(auth)) {
    throw usage(`--auth must be one of ${CLAUDE_AUTH_MODES.join(', ')}.`);
  }
  const authMode = auth as ClaudeAuthMode;
  let maxBudgetUsd: number | undefined;
  if (flags.maxBudgetUsd !== undefined) {
    if (authMode !== 'api-key') {
      throw usage('--max-budget-usd is enforced only in API Key Mode; add --auth api-key.');
    }
    maxBudgetUsd = Number(flags.maxBudgetUsd);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw usage('--max-budget-usd expects a positive number of US dollars.');
    }
  }
  const baseline = flags.baseline ?? 'none';
  let baselineVersion: number | null = null;
  if (baseline !== 'none') {
    const match = /^v(.+)$/.exec(baseline);
    if (!match) throw usage('--baseline expects none or v<n>, e.g. --baseline v3.');
    baselineVersion = positiveInteger(match[1] as string, '--baseline v<n>');
  }
  return {
    suitePath: flags.suite,
    artifact: flags.artifact,
    version:
      flags.version === undefined
        ? undefined
        : positiveInteger(flags.version, '--artifact-version'),
    baselineVersion,
    authMode,
    maxBudgetUsd,
    approveCommands: Boolean(flags.approveCommands),
    yes: Boolean(flags.yes),
    json: Boolean(flags.json),
  };
}

/** `<suite>` is a definition file or a folder containing `benchmark.yaml` (FR-118-23). */
export function definitionPath(suite: string, cwd: string = process.cwd()): string {
  const path = resolve(cwd, suite);
  if (!existsSync(path)) throw usage(`Suite not found: ${path}`);
  if (!statSync(path).isDirectory()) return path;
  const file = join(path, 'benchmark.yaml');
  if (!existsSync(file)) throw usage(`${path} has no benchmark.yaml.`);
  return file;
}

export interface Resolved {
  ref: ResolvedArtifactRef;
  candidate: ArtifactBundle;
  baseline: ArtifactBundle | null;
}

function refusal(code: string, lines: readonly string[]): CliError {
  const shown = lines.slice(0, PLAN_FINDINGS_SHOWN);
  const more = lines.length - shown.length;
  return usage(
    [
      `Refused (${code}):`,
      ...shown.map((line) => `  - ${line}`),
      ...(more > 0 ? [`  … and ${more} more`] : []),
    ].join('\n'),
  );
}

/** Loads the candidate and the A/B baseline version (FR-118-12/22, §14). */
export async function resolveVersions(db: Database, options: RunOptions): Promise<Resolved> {
  try {
    const ref = await resolveArtifactRef(db, options.artifact, options.version);
    const candidate = (await getArtifactBundle(db, ref.version.id)) as ArtifactBundle;
    if (options.baselineVersion === null) return { ref, candidate, baseline: null };
    if (ref.versionCount < 2) {
      throw usage(
        `Artifact "${ref.artifact.slug}" has one version; an A/B baseline needs another one. Use --baseline none.`,
      );
    }
    const baselineRef = await resolveArtifactRef(db, ref.artifact.id, options.baselineVersion);
    const baseline = (await getArtifactBundle(db, baselineRef.version.id)) as ArtifactBundle;
    const issue = baselineArtifactIssue(candidate, baseline);
    if (issue) throw usage(`Invalid baseline v${options.baselineVersion}: ${issue}`);
    return { ref, candidate, baseline };
  } catch (error) {
    throw artifactRefCliError(error);
  }
}

/**
 * Suite-level refusals before any database change (FR-118-05/12/25/26/33, §13): the agent must be
 * `claude-code`, the environment supported, cases without `agentOptions`, an Anthropic model with
 * a safe name (or the CLI default), the artifact type in `artifactTypes` and installable, both
 * versions free of executable customizations, an A/B pair on one skill name, a `/` prompt only
 * with an A/B baseline, and a suite that runs commands approved (now or earlier).
 */
export async function checkSuite(
  db: Database,
  prepared: PreparedSuite,
  resolved: Resolved,
  options: RunOptions,
): Promise<{ runsCommands: boolean; alreadyApproved: boolean }> {
  const { definition } = prepared;
  if (definition.execution.agent !== CLAUDE_CODE_ADAPTER_ID) {
    throw usage(
      `benchmark run executes claude-code suites; this suite uses "${definition.execution.agent}" (the mock agent runs in \`directivebench demo\` and the web UI).`,
    );
  }
  const unsupported = executionBlockers(definition, true);
  if (unsupported[0]) throw usage(unsupported[0]);
  for (const testCase of definition.cases) {
    if (
      !claudeCodeCaseOptionsSchema.safeParse(testCase.agentOptions[CLAUDE_CODE_ADAPTER_ID]).success
    ) {
      throw usage(
        `Case ${testCase.id}: agentOptions.claude-code must be empty; the auth mode and profile come from the command line.`,
      );
    }
  }
  const { candidate, baseline } = resolved;
  if (!definition.artifactTypes.includes(candidate.type)) {
    throw usage(
      `The suite evaluates ${definition.artifactTypes.join(', ')} artifacts; "${candidate.slug}" is a ${candidate.type}.`,
    );
  }
  try {
    // The adapter rejects these per run, after `setup` and for every run (Codex review round 2).
    claudeModelArgs(definition.execution.model);
    claudeArtifactProfile(candidate);
    if (baseline && candidate.format === 'skill-md') {
      const issue = baselineSkillNameIssue(candidate, baseline);
      if (issue) throw refusal('baseline-skill-name-differs', [issue]);
    }
  } catch (error) {
    if (error instanceof ClaudeCodeError) throw refusal(error.code, [error.message]);
    throw error;
  }
  const findings = inspectArtifactVersions(candidate, baseline);
  const code = artifactRefusalCode(findings);
  if (code) {
    throw refusal(
      code,
      findings.map((finding) => `${finding.role} ${finding.file}: ${finding.detail}`),
    );
  }
  if (baseline === null) {
    const slash = definition.cases.find((testCase) => testCase.prompt.startsWith('/'));
    if (slash) {
      throw refusal('slash-prompt-needs-ab-baseline', [
        `Case ${slash.id}: an explicit /<name> invocation has no meaningful no-skill control; use an A/B baseline: --baseline v<n>.`,
      ]);
    }
  }
  const runsCommands = definitionRunsCommands(definition);
  const alreadyApproved =
    (await suiteVersionApproval(db, definition.id, prepared.contentHash)) === true;
  if (runsCommands && !alreadyApproved && !options.approveCommands) {
    throw usage(
      'This suite runs commands (setup or command assertions). Review them and pass --approve-commands to approve this suite version.',
    );
  }
  return { runsCommands, alreadyApproved };
}

function findingLine(finding: WorkspaceFinding, where: string): string {
  const extra = [finding.token, finding.target].filter((part) => part !== undefined);
  return `${where} ${finding.path}: ${finding.detail}${extra.length > 0 ? ` (${extra.join(' → ')})` : ''}`;
}

/**
 * The plan-time workspace inspection (FR-118-06/27): per case, the fixture and the overlay alone
 * (Claude Code configuration is `fixture-contains-claude-config`), then the fixture with each
 * version installed as the adapter installs it, so an import inside a bundled file is found too.
 * `~` resolves against `homeDir`, the agent's `HOME`; null stands for API Key Mode's fresh,
 * empty run-local home. Works in a temporary directory.
 */
export async function inspectWorkspaces(
  prepared: PreparedSuite,
  resolved: Resolved,
  fixtureStore: string,
  homeDir: string | null,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'directivebench-plan-'));
  const home = homeDir ?? join(root, 'home');
  let counter = 0;
  const findings: { code: string; line: string }[] = [];
  const check = async (snapshot: string, where: string, artifact: ArtifactBundle | null) => {
    counter += 1;
    const dir = join(root, String(counter));
    await copyTree(join(fixtureStore, snapshot), dir);
    const pin = await pinWorkspace(dir);
    const installed = artifact ? (await installClaudeArtifact(pin, artifact)).paths : [];
    const found = await inspectWorkspace(pin, {
      homeDir: home,
      installedPaths: installed,
      claudeConfigCode: 'fixture-contains-claude-config',
    });
    for (const finding of found)
      findings.push({ code: finding.code, line: findingLine(finding, where) });
  };
  try {
    for (const testCase of prepared.definition.cases) {
      const fixtures = prepared.fixtures[testCase.id] as PreparedSuite['fixtures'][string];
      await check(fixtures.fixture, `case ${testCase.id} fixture`, null);
      if (fixtures.overlay) await check(fixtures.overlay, `case ${testCase.id} overlay`, null);
      // Installing into a fixture that holds configuration fails; that finding is reported above.
      if (findings.length > 0) continue;
      await check(fixtures.fixture, `case ${testCase.id} with the candidate`, resolved.candidate);
      if (resolved.baseline) {
        await check(fixtures.fixture, `case ${testCase.id} with the baseline`, resolved.baseline);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const [first] = findings;
  if (first)
    throw refusal(
      first.code,
      findings.map((finding) => finding.line),
    );
}

/** Readiness of the chosen auth mode before the job exists (FR-118-35); exit 2 when not ready. */
export async function checkReadiness(
  authMode: ClaudeAuthMode,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodeReadinessReport> {
  const readiness = await checkClaudeCodeReadiness(authMode, env);
  if (!readiness.ready) {
    throw usage(`Claude Code is not ready (${readiness.code}): ${readiness.detail}`);
  }
  return readiness;
}

/** Whether a skill sets `disable-model-invocation` (shown in the plan, FR-118-31). */
export function disablesModelInvocation(artifact: ArtifactBundle): boolean {
  const skill = artifact.files.find((file) => file.path === 'SKILL.md');
  return (
    skill !== undefined &&
    parseSkillFrontmatter(skill.content).frontmatter['disable-model-invocation'] === true
  );
}

/** Validates the suite and stores its fixture snapshots; every failure is a usage error. */
export async function loadSuite(path: string, fixtureStore: string): Promise<PreparedSuite> {
  try {
    return await prepareSuiteImport(path, fixtureStore);
  } catch (error) {
    throw usage((error as Error).message);
  }
}
