import type { AgentRunMetadata, SkillActivation } from '@directivebench/agent-adapters';
import type { AgentProfile } from './orchestrator';
import type { ExecutionStatus, Variant } from './scoring';

/**
 * The engine's rules over what real-agent adapters report per agent run (SPEC-118 FR-118-04,
 * FR-118-09, FR-118-15): systematic failures stop the run, the installed skill must be loaded,
 * the agent conditions and the execution model must be identical for every agent run, and a
 * `none` baseline must not use the tested skill. Runs without reported metadata (the mock agent)
 * are untouched, so mock results are unchanged.
 */

/**
 * Agent-run codes whose cause is systematic: every further agent run would fail the same way and
 * spend the user's quota (FR-118-15).
 */
export const STOP_CODES: readonly string[] = [
  'auth-missing',
  'auth-expired',
  'auth-invalid',
  'billing',
  'rate-limited',
  'auth-mismatch',
  'artifact-not-loaded',
  'workspace-contains-claude-config',
  'workspace-imports-outside',
  'workspace-scan-limit',
];

/** The agent-run facts these rules read. */
export interface AgentRunFacts {
  caseId: string;
  variant: Variant;
  repetition: number;
  executionStatus: ExecutionStatus;
  score: number | null;
  passed: boolean | null;
  error: string | null;
  errorCode: string | null;
  warnings: string[];
  metadata?: AgentRunMetadata;
  skillActivation?: SkillActivation;
}

/** A systematic agent-run failure ended the benchmark run before its remaining agent runs. */
export class BenchmarkStoppedError extends Error {
  override name = 'BenchmarkStoppedError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Applies FR-118-09 (a) and (b) to one agent run, in place. The skill is installed in every
 * candidate workspace and, in an A/B run, in every baseline workspace: there an unloaded skill is
 * `infrastructure-error` `artifact-not-loaded` (a stop code takes precedence when the run already
 * failed with one), and a loaded skill that was never invoked is scored with warning
 * `artifact-not-invoked`. A `none` baseline has nothing installed, so neither rule applies.
 */
export function applySkillActivationRules<T extends AgentRunFacts>(
  record: T,
  abBaseline: boolean,
): T {
  const activation = record.skillActivation;
  if (!activation || (record.variant === 'baseline' && !abBaseline)) return record;
  if (!activation.loaded) {
    if (record.errorCode !== null && STOP_CODES.includes(record.errorCode)) return record;
    record.executionStatus = 'infrastructure-error';
    record.errorCode = 'artifact-not-loaded';
    record.error =
      'Claude Code did not load the installed skill (the Skill tool or the skill is missing from its session start).';
    record.score = null;
    record.passed = null;
    return record;
  }
  if (!activation.invoked && !record.warnings.includes('artifact-not-invoked')) {
    record.warnings.push('artifact-not-invoked');
  }
  return record;
}

/** Throws {@link BenchmarkStoppedError} when the agent run ended with a stop code (FR-118-15). */
export function assertNotStopped(record: AgentRunFacts): void {
  if (record.errorCode === null || !STOP_CODES.includes(record.errorCode)) return;
  throw new BenchmarkStoppedError(
    record.errorCode,
    `Stopped after case ${record.caseId}, ${record.variant} repetition ${record.repetition} (${record.errorCode}): ${record.error ?? 'no detail'}. No further agent runs were started.`,
  );
}

const PROFILE_FIELDS = [
  'adapterVersion',
  'authMode',
  'isolationProfile',
  'permissionProfile',
  'requestedModel',
  'flagsHash',
] as const satisfies readonly (keyof AgentRunMetadata)[];

function distinct(values: Iterable<string | null>): string[] {
  return [...new Set([...values].map((value) => value ?? 'none'))].sort();
}

/** The execution models of a variant: each run's session model and any mismatching message model. */
function variantModels(runs: readonly AgentRunFacts[], variant: Variant): string[] {
  return distinct(
    runs
      .filter((run) => run.variant === variant)
      .flatMap((run) => [
        ...(run.metadata?.executionModel ? [run.metadata.executionModel] : []),
        ...(run.metadata?.mismatchedMessageModels ?? []),
      ]),
  );
}

/**
 * Comparability issues of FR-118-04 and FR-118-09 (c); each makes the run `not-comparable`:
 * a differing agent condition, more than one execution model across all agent runs (including a
 * main-conversation message on another model), and a `none` baseline that invoked the tested
 * skill.
 */
export function agentConditionIssues(
  runs: readonly AgentRunFacts[],
  abBaseline: boolean,
): string[] {
  const issues: string[] = [];
  const reported = runs.flatMap((run) => (run.metadata ? [run.metadata] : []));
  for (const field of PROFILE_FIELDS) {
    const values = distinct(reported.map((metadata) => metadata[field]));
    if (values.length > 1) {
      issues.push(`agent condition ${field} differs between agent runs (${values.join(', ')})`);
    }
  }
  const models = distinct([
    ...variantModels(runs, 'baseline'),
    ...variantModels(runs, 'candidate'),
  ]);
  if (models.length > 1) {
    issues.push(
      `execution-model-mismatch: agent runs used different execution models (baseline: ${variantModels(runs, 'baseline').join(', ') || 'none reported'}; candidate: ${variantModels(runs, 'candidate').join(', ') || 'none reported'})`,
    );
  }
  if (!abBaseline) {
    const invoking = runs.filter(
      (run) => run.variant === 'baseline' && run.skillActivation?.invoked,
    ).length;
    if (invoking > 0) {
      issues.push(
        `baseline-invoked-tested-skill: ${invoking} baseline run(s) without the artifact invoked the tested skill (an ambient copy), so the baseline is not a no-skill control`,
      );
    }
  }
  return issues;
}

export interface SkillInvocationRate {
  invoked: number;
  runs: number;
}

/** Invocation rate per variant over the runs that reported `skillActivation` (FR-118-09). */
export function skillInvocationRates(
  runs: readonly AgentRunFacts[],
): Record<Variant, SkillInvocationRate> | undefined {
  if (!runs.some((run) => run.skillActivation)) return undefined;
  const rate = (variant: Variant): SkillInvocationRate => {
    const reported = runs.filter((run) => run.variant === variant && run.skillActivation);
    return {
      invoked: reported.filter((run) => run.skillActivation?.invoked).length,
      runs: reported.length,
    };
  };
  return { baseline: rate('baseline'), candidate: rate('candidate') };
}

/**
 * Warnings of FR-118-04 and FR-118-09 for the benchmark run: differing auxiliary models
 * (`auxiliary-models`, not a comparability failure), an unpinned or aliased model
 * (`unpinned-model`), the invocation rate per variant, and each agent-run warning with its count.
 */
export function agentConditionWarnings(
  runs: readonly AgentRunFacts[],
  abBaseline: boolean,
): string[] {
  const warnings: string[] = [];
  const reported = runs.flatMap((run) => (run.metadata ? [run.metadata] : []));
  const auxiliary = distinct(reported.map((metadata) => metadata.auxiliaryModels.join(', ')));
  if (auxiliary.length > 1) {
    warnings.push(
      `auxiliary-models: agent runs used different auxiliary models for internal work (${auxiliary.map((set) => set || 'none').join(' / ')}); the execution model was the same`,
    );
  }
  const unpinned = reported.some(
    (metadata) =>
      metadata.requestedModel === null ||
      (metadata.executionModel !== null && metadata.requestedModel !== metadata.executionModel),
  );
  if (unpinned) {
    warnings.push(
      `unpinned-model: the suite does not pin a full model name, so the CLI chose it (${distinct(reported.map((metadata) => metadata.executionModel)).join(', ')})`,
    );
  }
  const rates = skillInvocationRates(runs);
  if (rates) {
    const candidate = rates.candidate;
    warnings.push(
      `Skill invoked in ${candidate.invoked}/${candidate.runs} candidate runs${abBaseline ? ` and ${rates.baseline.invoked}/${rates.baseline.runs} baseline runs` : ''}.`,
    );
    if (candidate.runs > 0 && candidate.invoked === 0) {
      warnings.push(
        'artifact-not-invoked: the skill was never invoked in a candidate run, so the result measures a skill that was never used.',
      );
    }
  }
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const warning of new Set(run.warnings))
      counts.set(warning, (counts.get(warning) ?? 0) + 1);
  }
  for (const [warning, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    warnings.push(`${warning}: ${count}/${runs.length} agent runs`);
  }
  return warnings;
}

/**
 * The agent profile of the comparability key (SPEC-118 §8.3); undefined when no agent run
 * reported metadata (the mock agent: every existing key stays byte-identical). The fields come
 * from the first reporting run; the execution model is the sorted set of observed models, so a
 * run whose agent runs disagree (`not-comparable`) never joins a clean group. A `user-profile`
 * run needs the installation's `hostId`: without one there is no profile and the run is not
 * comparable (issue `host-id-missing`), so results that may include one machine's user-level
 * configuration never share a key with another machine's.
 */
export function observedAgentProfile(
  runs: readonly AgentRunFacts[],
  hostId: string | undefined,
): { profile?: AgentProfile; issue?: string } {
  const first = runs.find((run) => run.metadata)?.metadata;
  if (!first) return {};
  const models = distinct([
    ...variantModels(runs, 'baseline'),
    ...variantModels(runs, 'candidate'),
  ]);
  const common = {
    authMode: first.authMode,
    permissionProfile: first.permissionProfile,
    flagsHash: first.flagsHash,
    executionModel: models.join(' | '),
  };
  if (first.isolationProfile === 'isolated') {
    return { profile: { ...common, isolationProfile: 'isolated' } };
  }
  if (hostId === undefined) {
    return {
      issue:
        'host-id-missing: the run may include user-level configuration, but no installation id was given to tell machines apart',
    };
  }
  return { profile: { ...common, isolationProfile: 'user-profile', hostId } };
}

/**
 * Puts the agent-run metadata first in the trace (SPEC-118 §8.1): execution and reported models,
 * `skillActivation`, the final error code and warnings, after the rules above were applied.
 */
export function addAgentMetadataEvent(record: AgentRunFacts & { trace: unknown[] }): void {
  if (!record.metadata) return;
  record.trace.unshift({
    type: 'agent-metadata',
    metadata: record.metadata,
    ...(record.skillActivation ? { skillActivation: record.skillActivation } : {}),
    errorCode: record.errorCode,
    warnings: [...record.warnings],
  });
}
