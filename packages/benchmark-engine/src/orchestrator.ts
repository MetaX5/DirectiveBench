import { cp, mkdir, rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeError,
  pinWorkspace,
  workspacePinIssue,
  type AgentAdapter,
  type AgentRunMetadata,
  type AgentRunResult,
  type SkillActivation,
  type TraceEvent,
} from '@directivebench/agent-adapters';
import {
  baselineArtifactIssue,
  canonicalJson,
  hashManifest,
  sha256,
  type ArtifactBundle,
} from '@directivebench/core';
import {
  addAgentMetadataEvent,
  agentConditionIssues,
  agentConditionWarnings,
  applySkillActivationRules,
  assertNotStopped,
  observedAgentProfile,
  skillInvocationRates,
} from './agent-conditions';
import { evaluateAssertion, type AssertionResult } from './assertions';
import { buildCommandEnv, runCommand } from './commands';
import {
  executionBlockers,
  isDeterministicAssertion,
  type BenchmarkCase,
  type BenchmarkDefinition,
} from './definition';
import { buildManifest, copyTree, diffManifests, type FileChange } from './files';
import type { CaseFixtures } from './import';
import {
  scoreRun,
  summarize,
  type ExecutionStatus,
  type RunOutcome,
  type ScoringSummary,
  type Variant,
} from './scoring';

export class BenchmarkConfigurationError extends Error {
  override name = 'BenchmarkConfigurationError';
}

export class BenchmarkCancelledError extends Error {
  override name = 'BenchmarkCancelledError';
  constructor() {
    super('Benchmark run cancelled');
  }
}

export interface AgentRunRecord extends RunOutcome {
  fixtureHash: string;
  changedFiles: FileChange[];
  trace: (TraceEvent | EngineTraceEvent)[];
  usage: Record<string, number> | null;
  error: string | null;
  /**
   * SPEC-203 §9 / SPEC-118 code of a failed agent run, when known (from the adapter's
   * `errorCode`, or the engine's own: `stray-processes`, `workspace-replaced`, `assertion-error`).
   * A code in `STOP_CODES` stops the benchmark run (FR-118-15).
   */
  errorCode: string | null;
  /** Warning codes of this agent run (adapter warnings and `artifact-not-invoked`). */
  warnings: string[];
  /** Reported by real-agent adapters (FR-118-04); absent for the mock agent. */
  metadata?: AgentRunMetadata;
  /** `skill-md` runs of real-agent adapters (FR-118-09). */
  skillActivation?: SkillActivation;
  assertions: AssertionResult[];
}

/** Engine-level trace events (FR-110-15); adapter events are interleaved in order. */
export type EngineTraceEvent =
  | {
      type: 'stage';
      stage: 'prepare' | 'setup' | 'install' | 'agent' | 'verification' | 'assertions';
      at: string;
    }
  | { type: 'setup'; command: string[]; exitCode: number | null; durationMs: number }
  /** First event of a real-agent run: its conditions and skill activation (SPEC-118 §8.1). */
  | {
      type: 'agent-metadata';
      metadata: AgentRunMetadata;
      skillActivation?: SkillActivation;
      errorCode: string | null;
      warnings: string[];
    };

/**
 * The agent conditions a real-agent adapter reports (SPEC-118 §8.2, SPEC-203 §4.2). `hostId`
 * — the installation's `installationId` from `config.json` — exists only for the `user-profile`
 * isolation, whose results may include one machine's user-level configuration (§8.3).
 */
export type AgentProfile = {
  authMode: 'subscription' | 'api-key';
  permissionProfile: 'edit-only' | 'edit-and-shell';
  /** sha256 of the normalised argv (FR-118-04). */
  flagsHash: string;
  /** The session model every agent run resolved (FR-118-04). */
  executionModel: string;
} & ({ isolationProfile: 'isolated' } | { isolationProfile: 'user-profile'; hostId: string });

export interface EnvironmentMetadata {
  kind: 'local-process';
  sandboxed: false;
  platform: string;
  arch: string;
  nodeVersion: string;
  adapterId: string;
  adapterVersion: string | null;
  deterministicAgent: boolean;
  model: BenchmarkDefinition['execution']['model'];
  timeoutSeconds: number;
  repetitions: number;
  /** Reported by real-agent adapters only; absent for the mock agent (SPEC-118 §8.3). */
  agentProfile?: AgentProfile;
}

export interface RunBenchmarkInput {
  definition: BenchmarkDefinition;
  /** Fixture hashes per case (from the stored suite version). */
  fixtures: Record<string, CaseFixtures>;
  /** Content-addressed fixture store (`<dataDir>/fixtures`). */
  fixtureStore: string;
  /** The candidate: the artifact version under test. */
  artifact: ArtifactBundle;
  /**
   * The A/B baseline: another version of the same artifact, installed into every baseline
   * workspace exactly as the candidate is installed into its own. Absent = baseline kind `none`,
   * a workspace without the artifact (SPEC-118 FR-118-10/11).
   */
  baselineArtifact?: ArtifactBundle;
  adapter: AgentAdapter;
  /**
   * The installation's id (`config.json` `installationId`), required in the comparability key of
   * runs whose isolation profile is `user-profile` (SPEC-118 §8.3).
   */
  hostId?: string;
  /** Directory for temporary workspaces of this run; removed afterwards unless `keepWorkspaces`. */
  workRoot: string;
  keepWorkspaces?: boolean;
  /** Whether the suite version is approved to execute commands. */
  executionApproved: boolean;
  signal: AbortSignal;
  /** Called after each agent run so callers can persist results incrementally. */
  onAgentRun?: (record: AgentRunRecord) => Promise<void>;
}

export interface BenchmarkOutcome {
  summary: ScoringSummary;
  comparabilityKey: string;
  environment: EnvironmentMetadata;
  warnings: string[];
  agentRuns: AgentRunRecord[];
}

/** Validates that a run can start, before any workspace is created. */
export function assertRunnable(
  input: Pick<
    RunBenchmarkInput,
    'definition' | 'fixtures' | 'artifact' | 'baselineArtifact' | 'adapter' | 'executionApproved'
  >,
): void {
  const { definition, adapter } = input;
  const [blocker] = executionBlockers(definition, input.executionApproved);
  if (blocker) throw new BenchmarkConfigurationError(blocker);
  if (definition.execution.agent !== adapter.id) {
    throw new BenchmarkConfigurationError(
      `Suite requires agent "${definition.execution.agent}" but adapter "${adapter.id}" was provided.`,
    );
  }
  if (!adapter.capabilities.execution) {
    throw new BenchmarkConfigurationError(
      `Agent "${adapter.id}" cannot execute benchmarks in this build.`,
    );
  }
  if (definition.execution.model && !adapter.capabilities.modelSelection) {
    throw new BenchmarkConfigurationError(
      `Agent "${adapter.id}" does not support model selection, but the suite sets execution.model.`,
    );
  }
  if (!adapter.capabilities.headless || !adapter.capabilities.artifactInstallation) {
    throw new BenchmarkConfigurationError(
      `Agent "${adapter.id}" must support headless execution and artifact installation for RED/GREEN runs.`,
    );
  }
  if (!definition.artifactTypes.includes(input.artifact.type)) {
    throw new BenchmarkConfigurationError(
      `Suite evaluates ${definition.artifactTypes.join(', ')} artifacts, not ${input.artifact.type}.`,
    );
  }
  if (input.baselineArtifact) {
    const issue = baselineArtifactIssue(input.artifact, input.baselineArtifact);
    if (issue) throw new BenchmarkConfigurationError(issue);
  }
  for (const benchmarkCase of definition.cases) {
    if (!input.fixtures[benchmarkCase.id]) {
      throw new BenchmarkConfigurationError(
        `No fixture snapshot recorded for case "${benchmarkCase.id}".`,
      );
    }
  }
}

/**
 * Comparability key (SPEC-111 FR-111-43, SPEC-118 §8.3): results are only aggregated or compared
 * when everything except the artifact version is identical. `agentProfile` is hashed only when
 * an adapter reports one, so every mock-agent key stays byte-identical. The A/B baseline is not
 * part of the key: it says what the candidate was compared with, not under which conditions.
 */
export function comparabilityKey(
  definition: BenchmarkDefinition,
  fixtures: Record<string, CaseFixtures>,
  adapterId: string,
  adapterVersion: string | null,
  agentProfile?: AgentProfile,
): string {
  return sha256(
    canonicalJson({
      cases: definition.cases,
      scoring: definition.scoring,
      execution: definition.execution,
      fixtures,
      adapterId,
      adapterVersion,
      ...(agentProfile ? { agentProfile } : {}),
    }),
  );
}

/**
 * How long the engine waits, after an agent run's timeout, for the adapter to return before it
 * records the run as timed out and moves on. Longer than an adapter's own stop sequence (SIGTERM,
 * a 5 s grace, SIGKILL of the process group and waiting for it, SPEC-203 §5), so an adapter that
 * honours the signal always reports its own result.
 */
export const AGENT_STOP_GRACE_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The agent's abort signal: aborts when `cancel` aborts or after `timeoutMs`. `cancel` must not
 * be aborted yet. Deliberately a plain controller signal rather than
 * `AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)])`: Node follows a composite signal's
 * sources only through weak references until someone listens to it, so once the fired timeout
 * signal is garbage-collected, an adapter that polls `signal.aborted` would read `false` forever.
 */
function agentAbortSignal(
  cancel: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCancel = () => controller.abort(cancel.reason);
  cancel.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('The agent run timed out', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      cancel.removeEventListener('abort', onCancel);
    },
  };
}

async function executeAgentRun(
  input: RunBenchmarkInput,
  benchmarkCase: BenchmarkCase,
  variant: Variant,
  repetition: number,
): Promise<AgentRunRecord> {
  const { definition, adapter } = input;
  const caseFixtures = input.fixtures[benchmarkCase.id] as CaseFixtures;
  const started = performance.now();
  const runDir = join(input.workRoot, benchmarkCase.id, `${variant}-${repetition}`);
  const workspaceDir = join(runDir, 'workspace');
  const homeDir = join(runDir, 'home');
  const scratchDir = join(runDir, 'agent');
  const trace: AgentRunRecord['trace'] = [];
  const stage = (name: Extract<EngineTraceEvent, { type: 'stage' }>['stage']) =>
    trace.push({ type: 'stage', stage: name, at: new Date().toISOString() });
  const timeoutMs = definition.execution.timeoutSeconds * 1000;
  const commandEnv = buildCommandEnv(homeDir);
  const base: Omit<
    AgentRunRecord,
    'executionStatus' | 'score' | 'passed' | 'durationMs' | 'error'
  > = {
    caseId: benchmarkCase.id,
    variant,
    repetition,
    fixtureHash: caseFixtures.fixture,
    changedFiles: [],
    trace,
    usage: null,
    errorCode: null,
    warnings: [],
    assertions: [] as AssertionResult[],
  };
  const fail = (
    executionStatus: ExecutionStatus,
    error: string,
    errorCode: string | null = null,
  ): AgentRunRecord => ({
    ...base,
    executionStatus,
    score: null,
    passed: null,
    durationMs: Math.round(performance.now() - started),
    error,
    errorCode,
  });

  try {
    stage('prepare');
    await mkdir(homeDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });
    await copyTree(join(input.fixtureStore, caseFixtures.fixture), workspaceDir);
    // The workspace must be byte-identical to the immutable snapshot (FR-110-02).
    const copiedHash = hashManifest(await buildManifest(workspaceDir));
    if (copiedHash !== caseFixtures.fixture) {
      return fail(
        'infrastructure-error',
        `Workspace does not match fixture snapshot ${caseFixtures.fixture.slice(0, 12)} (got ${copiedHash.slice(0, 12)}); the fixture store may be corrupted.`,
      );
    }
    // Pin the workspace before any untrusted command runs in it: installation and the adapter's
    // checks compare the path with this identity, so a `setup` command that moves the workspace
    // away and leaves a link to another directory is refused (SPEC-118 §12).
    const workspace = await pinWorkspace(workspaceDir);

    if (benchmarkCase.setup.length > 0) stage('setup');
    for (const command of benchmarkCase.setup) {
      const result = await runCommand(command, {
        cwd: workspaceDir,
        env: commandEnv,
        timeoutMs,
        maxOutputBytes: definition.execution.maxOutputBytes,
        signal: input.signal,
      });
      trace.push({
        type: 'setup',
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      if (result.cancelled) return fail('cancelled', 'Cancelled during setup');
      // runCommand killed what the command left in its process group; a survivor could still
      // change the workspace after installation and the adapter's checks.
      if (result.strayProcesses) {
        return fail(
          'infrastructure-error',
          `Setup command left processes that could not be stopped: ${command.join(' ')}`,
          'stray-processes',
        );
      }
      if (result.exitCode !== 0) {
        return fail(
          'infrastructure-error',
          `Setup command failed: ${command.join(' ')} (${result.error ?? result.exitCode ?? result.signal})`,
        );
      }
    }

    const replaced = await workspacePinIssue(workspace);
    if (replaced !== null) {
      return fail(
        'infrastructure-error',
        `workspace-replaced: ${replaced} after setup.`,
        'workspace-replaced',
      );
    }

    // The baseline variant installs the baseline version, if any, by the same procedure.
    const installing = variant === 'candidate' ? input.artifact : input.baselineArtifact;
    let installedPaths: string[] = [];
    if (installing) {
      stage('install');
      installedPaths = (await adapter.installArtifact(workspace, installing)).paths;
      trace.push({
        type: 'message',
        text: `Installed artifact files: ${installedPaths.join(', ')}`,
      });
    }

    // Snapshot after installation so only the agent's own changes are tracked.
    const before = await buildManifest(workspaceDir);
    // Never start the agent after cancellation; also a precondition of agentAbortSignal.
    if (input.signal.aborted) return fail('cancelled', 'Cancelled');
    stage('agent');
    const agentAbort = agentAbortSignal(input.signal, timeoutMs);
    let agentResult: AgentRunResult;
    try {
      agentResult = await withTimeout(
        adapter.run({
          workspace,
          installedPaths,
          scratchDir,
          prompt: benchmarkCase.prompt,
          timeoutMs,
          signal: agentAbort.signal,
          model: definition.execution.model,
          options: benchmarkCase.agentOptions[adapter.id],
        }),
        timeoutMs + AGENT_STOP_GRACE_MS,
        () => ({
          status: 'timeout',
          durationMs: timeoutMs,
          summary: 'Timed out',
          trace: [],
          usage: null,
          error: 'Agent did not stop after timeout',
        }),
      );
    } finally {
      agentAbort.dispose();
    }
    trace.push(...agentResult.trace);
    base.errorCode = agentResult.errorCode ?? null;
    base.warnings = [...(agentResult.warnings ?? [])];
    if (agentResult.metadata) base.metadata = agentResult.metadata;
    if (agentResult.skillActivation) base.skillActivation = agentResult.skillActivation;
    if (input.signal.aborted) return fail('cancelled', 'Cancelled');
    if (agentResult.status !== 'completed') {
      return fail(
        agentResult.status,
        agentResult.error ?? agentResult.summary,
        agentResult.errorCode ?? null,
      );
    }

    const after = await buildManifest(workspaceDir);
    const changedFiles = diffManifests(before, after);

    stage('verification');
    if (caseFixtures.overlay) {
      await cp(join(input.fixtureStore, caseFixtures.overlay), workspaceDir, {
        recursive: true,
        force: true,
      });
    }

    stage('assertions');
    const assertions: AssertionResult[] = [];
    for (const assertion of benchmarkCase.assertions) {
      if (input.signal.aborted) return fail('cancelled', 'Cancelled during assertions');
      assertions.push(
        await evaluateAssertion(assertion, {
          workspaceDir,
          changedFiles,
          commandEnv,
          defaultTimeoutMs: timeoutMs,
          maxOutputBytes: definition.execution.maxOutputBytes,
          signal: input.signal,
        }),
      );
    }
    // A bounded pattern terminated by cancellation must not read as an assertion error.
    if (input.signal.aborted) return fail('cancelled', 'Cancelled during assertions');
    const usage = agentResult.usage ? { ...agentResult.usage } : null;
    // An evaluation that could not finish is neither pass nor fail: the run is excluded from
    // quality and keeps its assertion results as evidence (SPEC-118 FR-118-46, SPEC-111 §13).
    const unfinished = assertions.find((assertion) => assertion.error);
    if (unfinished) {
      return {
        ...fail(
          'infrastructure-error',
          `assertion-error: assertion "${unfinished.assertionId}" could not be evaluated: ${unfinished.message}`,
          'assertion-error',
        ),
        changedFiles,
        assertions,
        usage,
      };
    }
    const { score, passed } = scoreRun(assertions, definition.scoring.passThreshold);
    return {
      ...base,
      changedFiles,
      assertions,
      usage,
      executionStatus: 'completed',
      score,
      passed,
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    // An adapter's refusal (e.g. an installation that finds executable code) keeps its code.
    return fail(
      'infrastructure-error',
      error instanceof Error ? error.message : String(error),
      error instanceof ClaudeCodeError ? error.code : null,
    );
  } finally {
    if (!input.keepWorkspaces) await rm(runDir, { recursive: true, force: true });
  }
}

/**
 * Post-run equivalence check (FR-112-08): every baseline and candidate run of a case must have
 * started from the recorded fixture snapshot, and the agent version must not change during the
 * run. Returns the list of mismatches (empty when comparable).
 */
export function equivalenceIssues(
  fixtures: Record<string, CaseFixtures>,
  agentRuns: readonly Pick<AgentRunRecord, 'caseId' | 'variant' | 'repetition' | 'fixtureHash'>[],
  adapterVersionBefore: string | null,
  adapterVersionAfter: string | null,
): string[] {
  const issues: string[] = [];
  for (const run of agentRuns) {
    const expected = fixtures[run.caseId]?.fixture;
    if (run.fixtureHash !== expected) {
      issues.push(
        `case ${run.caseId}: ${run.variant} repetition ${run.repetition} used a different fixture snapshot`,
      );
    }
  }
  if (adapterVersionBefore !== adapterVersionAfter) {
    issues.push(
      `agent version changed during the run (${adapterVersionBefore} → ${adapterVersionAfter})`,
    );
  }
  return issues;
}

/**
 * RED/GREEN evaluation. For each case and repetition the baseline (no artifact, or the exact
 * baseline version installed) and candidate (exact artifact version installed) run in fresh,
 * independent workspaces from the same fixture snapshot with identical prompt, adapter, model and
 * limits. The order alternates between repetitions to reduce drift. Results are never adjusted:
 * a baseline may pass, a candidate may fail.
 */
export async function runBenchmark(input: RunBenchmarkInput): Promise<BenchmarkOutcome> {
  assertRunnable(input);
  const { definition, adapter } = input;
  const detection = await adapter.detect();
  const environment: EnvironmentMetadata = {
    kind: 'local-process',
    sandboxed: false,
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    adapterId: adapter.id,
    adapterVersion: detection.version,
    deterministicAgent: adapter.capabilities.deterministic,
    model: definition.execution.model,
    timeoutSeconds: definition.execution.timeoutSeconds,
    repetitions: definition.execution.repetitions,
  };
  const warnings = [
    'Execution environment "local-process" is not a sandbox: commands run with your user account permissions.',
  ];
  if (adapter.id === 'mock') {
    warnings.push(
      'Mock agent: results demonstrate the evaluation pipeline and are not an AI evaluation.',
    );
  }
  if (definition.execution.repetitions < 3 && !adapter.capabilities.deterministic) {
    warnings.push(
      'Fewer than 3 repetitions: a single nondeterministic execution is not conclusive.',
    );
  }

  await mkdir(input.workRoot, { recursive: true });
  const abBaseline = input.baselineArtifact !== undefined;
  const agentRuns: AgentRunRecord[] = [];
  try {
    for (const benchmarkCase of definition.cases) {
      for (let repetition = 1; repetition <= definition.execution.repetitions; repetition += 1) {
        const order: Variant[] =
          repetition % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          if (input.signal.aborted) throw new BenchmarkCancelledError();
          const record = applySkillActivationRules(
            await executeAgentRun(input, benchmarkCase, variant, repetition),
            abBaseline,
          );
          addAgentMetadataEvent(record);
          agentRuns.push(record);
          await input.onAgentRun?.(record);
          if (record.executionStatus === 'cancelled') throw new BenchmarkCancelledError();
          // A systematic failure (workspace refused, login, quota, skill not loaded, …) ends the
          // run: no further setup, installation or adapter call (FR-118-15).
          assertNotStopped(record);
        }
      }
    }
  } finally {
    if (!input.keepWorkspaces) await rm(input.workRoot, { recursive: true, force: true });
  }

  const finalDetection = await adapter.detect();
  const comparabilityIssues = equivalenceIssues(
    input.fixtures,
    agentRuns,
    detection.version,
    finalDetection.version,
  );
  // Real agents: identical conditions and execution model for every agent run (FR-118-04/09).
  comparabilityIssues.push(...agentConditionIssues(agentRuns, abBaseline));
  const observed = observedAgentProfile(agentRuns, input.hostId);
  if (observed.issue) comparabilityIssues.push(observed.issue);
  if (observed.profile) environment.agentProfile = observed.profile;
  warnings.push(...comparabilityIssues, ...agentConditionWarnings(agentRuns, abBaseline));

  const summary = summarize(agentRuns, {
    caseIds: definition.cases.map((c) => c.id),
    scoring: definition.scoring,
    repetitions: definition.execution.repetitions,
    comparable: comparabilityIssues.length === 0,
    comparabilityIssues,
    deterministicAgent: adapter.capabilities.deterministic,
    nondeterministicAssertions: definition.cases.some((c) =>
      c.assertions.some((a) => !isDeterministicAssertion(a)),
    ),
  });
  const invocation = skillInvocationRates(agentRuns);
  if (invocation) summary.skillInvocation = invocation;
  if (!summary.conclusive) {
    warnings.push('Single repetition of a nondeterministic run: the result is not conclusive.');
  }
  if (adapter.capabilities.deterministic && summary.verdict !== 'error') {
    warnings.push(
      'Deterministic agent: repetitions confirm reproducibility, not statistical confidence.',
    );
  }

  return {
    summary,
    comparabilityKey: comparabilityKey(
      definition,
      input.fixtures,
      adapter.id,
      detection.version,
      environment.agentProfile,
    ),
    environment,
    warnings,
    agentRuns,
  };
}
