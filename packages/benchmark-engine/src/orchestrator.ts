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
  type WorkspacePin,
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
  STOP_CODES,
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
  captureOutputFiles,
  NOT_CAPTURED,
  notKeptOutput,
  summarizeCapture,
  type OutputFilesCapture,
  type OutputFilesSummary,
} from './output-files';
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
  /** Skills other than the tested one the agent used (FR-118-08); real-agent adapters only. */
  otherSkillsInvoked?: string[];
  assertions: AssertionResult[];
  /**
   * Metadata of the captured output files (SPEC-123 FR-123-10). The content never lives here: it
   * is passed once to `onAgentRun` as an {@link OutputFilesCapture}.
   */
  outputFiles: OutputFilesSummary;
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
  /**
   * Called after each agent run so callers can persist results incrementally. `capture` holds the
   * content of the files the agent run wrote (null when none were kept, the reason is then in
   * `record.outputFiles`); the engine drops it once the callback has resolved (SPEC-123
   * FR-123-10). Without this callback the engine captures no output files.
   */
  onAgentRun?: (record: AgentRunRecord, capture: OutputFilesCapture | null) => Promise<void>;
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

/** The run-local directory of one agent run: its workspace, home and agent scratch directory. */
function agentRunDir(
  input: RunBenchmarkInput,
  benchmarkCase: BenchmarkCase,
  variant: Variant,
  repetition: number,
): string {
  return join(input.workRoot, benchmarkCase.id, `${variant}-${repetition}`);
}

/** Reason stored for an agent run that ended before its output files were captured. */
export const OUTPUT_NOT_CAPTURED_REASON =
  'the agent run ended before its output files were captured';

/**
 * Runs one agent run. Its output files, once captured, stay with it on every later return path
 * (SPEC-123 A6): `output.capture` is set once and returned beside the record.
 */
async function executeAgentRun(
  input: RunBenchmarkInput,
  benchmarkCase: BenchmarkCase,
  variant: Variant,
  repetition: number,
): Promise<{ record: AgentRunRecord; capture: OutputFilesCapture | null }> {
  const output: { capture: OutputFilesCapture | null } = { capture: null };
  const record = await runAgentStages(input, benchmarkCase, variant, repetition, output);
  return { record, capture: output.capture };
}

async function runAgentStages(
  input: RunBenchmarkInput,
  benchmarkCase: BenchmarkCase,
  variant: Variant,
  repetition: number,
  output: { capture: OutputFilesCapture | null },
): Promise<AgentRunRecord> {
  const { definition, adapter } = input;
  // Nothing could keep the content without a consumer, so nothing is captured (FR-123-10).
  const capturing = input.onAgentRun !== undefined;
  const caseFixtures = input.fixtures[benchmarkCase.id] as CaseFixtures;
  const started = performance.now();
  const runDir = agentRunDir(input, benchmarkCase, variant, repetition);
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
    outputFiles: capturing ? notKeptOutput(OUTPUT_NOT_CAPTURED_REASON) : NOT_CAPTURED,
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

  // Set once the workspace is pinned; a step that throws after that is checked too.
  let pinned: WorkspacePin | null = null;
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
    // Pin the workspace before any untrusted command runs in it: installation and the adapter's
    // checks compare the path with this identity, so a `setup` command that moves the workspace
    // away and leaves a link to another directory is refused (SPEC-118 §12).
    const workspace = await pinWorkspace(workspaceDir);
    pinned = workspace;
    // Every step that runs untrusted code (setup, the agent, command assertions) is followed by this
    // check, so the next step never runs in, copies into or reads a replacement (SPEC-118 §12).
    const replacedAfter = async (step: string): Promise<AgentRunRecord | null> => {
      const replaced = await workspacePinIssue(workspace);
      return replaced === null
        ? null
        : fail(
            'infrastructure-error',
            `workspace-replaced: ${replaced} after ${step}.`,
            'workspace-replaced',
          );
    };

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
      const replaced = await replacedAfter('setup');
      if (replaced) return replaced;
      if (result.exitCode !== 0) {
        return fail(
          'infrastructure-error',
          `Setup command failed: ${command.join(' ')} (${result.error ?? result.exitCode ?? result.signal})`,
        );
      }
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
    // The adapter's private directory (an isolated home, temporary files) is created only now and
    // exclusively: `setup` runs in the workspace and can reach its parent, so a directory created
    // before it could hold planted configuration or be a link to a host directory. The pin check
    // after `setup` showed the run directory is still the run's own.
    try {
      await mkdir(scratchDir, { mode: 0o700 });
    } catch (error) {
      return fail(
        'infrastructure-error',
        `The run-local agent directory could not be created fresh (${(error as NodeJS.ErrnoException).code}); a setup command may have created it.`,
      );
    }
    // Never start the agent after cancellation; also a precondition of agentAbortSignal.
    if (input.signal.aborted) return fail('cancelled', 'Cancelled');
    stage('agent');
    const agentAbort = agentAbortSignal(input.signal, timeoutMs);
    let agentResult: AgentRunResult;
    // Set when the engine gave up waiting: the agent may still be writing (FR-123-01).
    let agentStillRunning = false;
    try {
      agentResult = await withTimeout(
        adapter.run({
          workspace,
          installedPaths,
          scratchDir,
          artifact: input.artifact,
          baselineArtifact: input.baselineArtifact ?? null,
          prompt: benchmarkCase.prompt,
          timeoutMs,
          signal: agentAbort.signal,
          model: definition.execution.model,
          options: benchmarkCase.agentOptions[adapter.id],
        }),
        timeoutMs + AGENT_STOP_GRACE_MS,
        () => {
          agentStillRunning = true;
          return {
            status: 'timeout',
            durationMs: timeoutMs,
            summary: 'Timed out',
            trace: [],
            usage: null,
            error: 'Agent did not stop after timeout',
          };
        },
      );
    } finally {
      agentAbort.dispose();
    }
    trace.push(...agentResult.trace);
    base.errorCode = agentResult.errorCode ?? null;
    base.warnings = [...(agentResult.warnings ?? [])];
    if (agentResult.metadata) base.metadata = agentResult.metadata;
    if (agentResult.skillActivation) base.skillActivation = agentResult.skillActivation;
    if (agentResult.otherSkillsInvoked) base.otherSkillsInvoked = agentResult.otherSkillsInvoked;
    if (input.signal.aborted) return fail('cancelled', 'Cancelled');
    // Whatever the agent run's status: a failed or timed-out run that replaced the workspace must
    // still stop the benchmark run, and a code that already stops it keeps precedence.
    const stopped =
      agentResult.errorCode !== undefined && STOP_CODES.includes(agentResult.errorCode);
    if (!stopped) {
      const replacedByAgent = await replacedAfter('the agent run');
      if (replacedByAgent) {
        return capturing
          ? {
              ...replacedByAgent,
              outputFiles: notKeptOutput('the workspace was replaced during the agent run'),
            }
          : replacedByAgent;
      }
    }
    // Output files of a run whose process tree has exited and whose workspace pin still holds,
    // before the verification overlay (FR-123-01).
    const capture = async (measured: Parameters<typeof captureOutputFiles>[0]['measured']) => {
      const outcome = await captureOutputFiles({
        workspace,
        before,
        measured,
        installedPaths,
        adapter,
      });
      if (!outcome.ok) {
        base.outputFiles = notKeptOutput(outcome.reason);
        return null;
      }
      output.capture = outcome.capture;
      base.outputFiles = summarizeCapture(outcome.capture);
      return outcome.changes;
    };
    if (agentResult.status !== 'completed') {
      if (agentStillRunning) {
        if (capturing) base.outputFiles = notKeptOutput('the agent did not stop after its timeout');
      } else if (
        capturing &&
        !stopped &&
        (agentResult.status === 'agent-error' || agentResult.status === 'timeout')
      ) {
        // The capture's own manifest; a failure stays a capture failure (FR-123-02/03/09).
        const changes = await capture(null);
        if (changes) base.changedFiles = changes;
      }
      return fail(
        agentResult.status,
        agentResult.error ?? agentResult.summary,
        agentResult.errorCode ?? null,
      );
    }
    const after = await buildManifest(workspaceDir);
    const changedFiles = diffManifests(before, after);
    if (capturing) await capture({ after, changes: changedFiles });

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
      const evaluated = await evaluateAssertion(assertion, {
        workspaceDir,
        changedFiles,
        commandEnv,
        defaultTimeoutMs: timeoutMs,
        maxOutputBytes: definition.execution.maxOutputBytes,
        signal: input.signal,
      });
      assertions.push(evaluated);
      // A command assertion left processes that could not be stopped: they could change the
      // workspace under the next assertions and runs, so none runs (SPEC-118 §12, FR-118-15).
      if (evaluated.details?.strayProcesses === true) {
        return {
          ...fail(
            'infrastructure-error',
            `Assertion command left processes that could not be stopped: ${evaluated.assertionId}`,
            'stray-processes',
          ),
          changedFiles,
          assertions,
        };
      }
      if (assertion.type === 'command') {
        const replaced = await replacedAfter(`assertion ${evaluated.assertionId}`);
        if (replaced) return { ...replaced, changedFiles, assertions };
      }
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
    const code = error instanceof ClaudeCodeError ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    // A step that replaced the workspace and then threw (e.g. a rejecting adapter) must still stop
    // the benchmark run; a code that already stops it keeps precedence.
    if (pinned !== null && (code === null || !STOP_CODES.includes(code))) {
      const replaced = await workspacePinIssue(pinned);
      if (replaced !== null) {
        return fail(
          'infrastructure-error',
          `workspace-replaced: ${replaced} after an error (${message}).`,
          'workspace-replaced',
        );
      }
    }
    return fail('infrastructure-error', message, code);
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
 * Runs one agent run, records it and hands it to `onAgentRun` with its output files. The capture
 * is referenced only in this function's frame, so it is collectable as soon as the callback has
 * resolved, while the benchmark run goes on (SPEC-123 FR-123-10, NFR-123-06).
 */
async function runAndDeliver(
  input: RunBenchmarkInput,
  benchmarkCase: BenchmarkCase,
  variant: Variant,
  repetition: number,
  agentRuns: AgentRunRecord[],
): Promise<AgentRunRecord> {
  try {
    const executed = await executeAgentRun(input, benchmarkCase, variant, repetition);
    const record = applySkillActivationRules(executed.record, input.baselineArtifact !== undefined);
    addAgentMetadataEvent(record);
    agentRuns.push(record);
    await input.onAgentRun?.(record, executed.capture);
    return record;
  } finally {
    // Only after delivery: a workspace that cannot be removed still fails the benchmark run, but
    // can no longer discard the agent run and its captured files (Codex review round 3).
    if (!input.keepWorkspaces) {
      await rm(agentRunDir(input, benchmarkCase, variant, repetition), {
        recursive: true,
        force: true,
      });
    }
  }
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
          const record = await runAndDeliver(input, benchmarkCase, variant, repetition, agentRuns);
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
