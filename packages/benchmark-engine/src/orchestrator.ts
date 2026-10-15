import { cp, mkdir, rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentRunResult, TraceEvent } from '@directivebench/agent-adapters';
import { canonicalJson, hashManifest, sha256, type ArtifactBundle } from '@directivebench/core';
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
  assertions: AssertionResult[];
}

/** Engine-level trace events (FR-110-15); adapter events are interleaved in order. */
export type EngineTraceEvent =
  | {
      type: 'stage';
      stage: 'prepare' | 'setup' | 'install' | 'agent' | 'verification' | 'assertions';
      at: string;
    }
  | { type: 'setup'; command: string[]; exitCode: number | null; durationMs: number };

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
}

export interface RunBenchmarkInput {
  definition: BenchmarkDefinition;
  /** Fixture hashes per case (from the stored suite version). */
  fixtures: Record<string, CaseFixtures>;
  /** Content-addressed fixture store (`<dataDir>/fixtures`). */
  fixtureStore: string;
  artifact: ArtifactBundle;
  adapter: AgentAdapter;
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
    'definition' | 'fixtures' | 'artifact' | 'adapter' | 'executionApproved'
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
  for (const benchmarkCase of definition.cases) {
    if (!input.fixtures[benchmarkCase.id]) {
      throw new BenchmarkConfigurationError(
        `No fixture snapshot recorded for case "${benchmarkCase.id}".`,
      );
    }
  }
}

/**
 * Comparability key: results are only aggregated or compared when everything except the
 * artifact version is identical.
 */
export function comparabilityKey(
  definition: BenchmarkDefinition,
  fixtures: Record<string, CaseFixtures>,
  adapterId: string,
  adapterVersion: string | null,
): string {
  return sha256(
    canonicalJson({
      cases: definition.cases,
      scoring: definition.scoring,
      execution: definition.execution,
      fixtures,
      adapterId,
      adapterVersion,
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const trace: AgentRunRecord['trace'] = [];
  const stage = (name: Extract<EngineTraceEvent, { type: 'stage' }>['stage']) =>
    trace.push({ type: 'stage', stage: name, at: new Date().toISOString() });
  const timeoutMs = definition.execution.timeoutSeconds * 1000;
  const commandEnv = buildCommandEnv(homeDir);
  const base = {
    caseId: benchmarkCase.id,
    variant,
    repetition,
    fixtureHash: caseFixtures.fixture,
    changedFiles: [] as FileChange[],
    trace,
    usage: null,
    assertions: [] as AssertionResult[],
  };
  const fail = (executionStatus: ExecutionStatus, error: string): AgentRunRecord => ({
    ...base,
    executionStatus,
    score: null,
    passed: null,
    durationMs: Math.round(performance.now() - started),
    error,
  });

  try {
    stage('prepare');
    await mkdir(homeDir, { recursive: true });
    await copyTree(join(input.fixtureStore, caseFixtures.fixture), workspaceDir);
    // The workspace must be byte-identical to the immutable snapshot (FR-110-02).
    const copiedHash = hashManifest(await buildManifest(workspaceDir));
    if (copiedHash !== caseFixtures.fixture) {
      return fail(
        'infrastructure-error',
        `Workspace does not match fixture snapshot ${caseFixtures.fixture.slice(0, 12)} (got ${copiedHash.slice(0, 12)}); the fixture store may be corrupted.`,
      );
    }

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
      if (result.exitCode !== 0) {
        return fail(
          'infrastructure-error',
          `Setup command failed: ${command.join(' ')} (${result.error ?? result.exitCode ?? result.signal})`,
        );
      }
    }

    if (variant === 'candidate') {
      stage('install');
      const installed = await adapter.installArtifact(workspaceDir, input.artifact);
      trace.push({
        type: 'message',
        text: `Installed artifact files: ${installed.paths.join(', ')}`,
      });
    }

    // Snapshot after installation so only the agent's own changes are tracked.
    const before = await buildManifest(workspaceDir);
    stage('agent');
    const agentSignal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
    const agentResult: AgentRunResult = await withTimeout(
      adapter.run({
        workspaceDir,
        prompt: benchmarkCase.prompt,
        timeoutMs,
        signal: agentSignal,
        model: definition.execution.model,
        options: benchmarkCase.agentOptions[adapter.id],
      }),
      // Grace period for adapters that ignore the abort signal.
      timeoutMs + 5000,
      () => ({
        status: 'timeout',
        durationMs: timeoutMs,
        summary: 'Timed out',
        trace: [],
        usage: null,
        error: 'Agent did not stop after timeout',
      }),
    );
    trace.push(...agentResult.trace);
    if (input.signal.aborted) return fail('cancelled', 'Cancelled');
    if (agentResult.status !== 'completed') {
      return fail(agentResult.status, agentResult.error ?? agentResult.summary);
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
    const { score, passed } = scoreRun(assertions, definition.scoring.passThreshold);
    return {
      ...base,
      changedFiles,
      assertions,
      usage: agentResult.usage ? { ...agentResult.usage } : null,
      executionStatus: 'completed',
      score,
      passed,
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return fail('infrastructure-error', error instanceof Error ? error.message : String(error));
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
 * RED/GREEN evaluation. For each case and repetition the baseline (no artifact) and candidate
 * (exact artifact version installed) run in fresh, independent workspaces from the same fixture
 * snapshot with identical prompt, adapter, model and limits. The order alternates between
 * repetitions to reduce drift. Results are never adjusted: a baseline may pass, a candidate may fail.
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
  const agentRuns: AgentRunRecord[] = [];
  try {
    for (const benchmarkCase of definition.cases) {
      for (let repetition = 1; repetition <= definition.execution.repetitions; repetition += 1) {
        const order: Variant[] =
          repetition % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          if (input.signal.aborted) throw new BenchmarkCancelledError();
          const record = await executeAgentRun(input, benchmarkCase, variant, repetition);
          agentRuns.push(record);
          await input.onAgentRun?.(record);
          if (record.executionStatus === 'cancelled') throw new BenchmarkCancelledError();
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
  warnings.push(...comparabilityIssues);

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
    comparabilityKey: comparabilityKey(definition, input.fixtures, adapter.id, detection.version),
    environment,
    warnings,
    agentRuns,
  };
}
