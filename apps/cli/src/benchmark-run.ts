import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  CLAUDE_CODE_ADAPTER_ID,
  ClaudeCodeAdapter,
  type AgentAdapter,
  type ClaudeAuthMode,
} from '@directivebench/agent-adapters';
import {
  snapshotDirectory,
  type PreparedSuite,
  type ScoringSummary,
} from '@directivebench/benchmark-engine';
import {
  InvalidBaselineError,
  assignBenchmarkSuite,
  createBenchmarkRunJob,
  getBenchmarkRunDetail,
  type BenchmarkRunDetail,
} from '@directivebench/database';
import { LocalRunner } from '@directivebench/runner';
import {
  checkReadiness,
  checkSuite,
  definitionPath,
  disablesModelInvocation,
  inspectWorkspaces,
  loadSuite,
  parseRunFlags,
  resolveVersions,
  type BenchmarkRunFlags,
  type Resolved,
  type RunOptions,
} from './benchmark-plan';
import { CliError, ExitCode, resolveAssets } from './runtime';
import { initialize, openInitializedDatabase, readConfig } from './setup';

/** What `benchmark run` needs from the terminal and the process; replaced in tests. */
export interface RunTerminal {
  env: NodeJS.ProcessEnv;
  /** Whether a person can answer the confirmation (stdin and stdout are terminals). */
  interactive: boolean;
  /** Asks a yes/no question; true only for an explicit yes. */
  confirm(question: string): Promise<boolean>;
  /** Calls `handler` on Ctrl-C until the returned function is called. */
  onInterrupt(handler: () => void): () => void;
}

/**
 * Asks on `output` and reads one line from `input`; `y` or `yes` (any case) is a yes. An answer
 * that cannot be read — Ctrl-C at the prompt rejects with `AbortError`, a closed input — is a no:
 * nothing starts without an explicit yes.
 */
export async function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(`${question} [y/N] `).catch(() => '');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

/** A person can answer only when both stdin and stdout are terminals (FR-118-32). */
export function isInteractive(stdin: { isTTY?: boolean }, stdout: { isTTY?: boolean }): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export const processTerminal: RunTerminal = {
  env: process.env,
  interactive: isInteractive(process.stdin, process.stdout),
  confirm: askYesNo,
  onInterrupt(handler) {
    process.on('SIGINT', handler);
    return () => process.off('SIGINT', handler);
  },
};

/** The plan and notices printed before anything is stored or started (FR-118-31, FR-118-33). */
export function planText(input: {
  prepared: PreparedSuite;
  resolved: Resolved;
  options: RunOptions;
  agentVersion: string | null;
  storedApproved: boolean;
  runsCommands: boolean;
}): string[] {
  const { prepared, resolved, options } = input;
  const { definition } = prepared;
  const model = definition.execution.model;
  const runs = definition.cases.length * definition.execution.repetitions * 2;
  const lines = [
    `Suite:      ${definition.name} (${definition.id}, content ${prepared.contentHash.slice(0, 12)})`,
    `Candidate:  ${resolved.candidate.slug} v${resolved.ref.version.version}`,
    `Baseline:   ${resolved.baseline ? `v${options.baselineVersion}` : 'no artifact'}`,
    `Agent:      Claude Code ${input.agentVersion ?? '(version unknown)'}`,
    `Auth mode:  ${options.authMode === 'subscription' ? 'Local Subscription Mode (isolation: user-profile)' : 'API Key Mode (isolation: isolated)'}`,
    `Model:      ${model ? `${model.provider}/${model.model}` : 'CLI default — unpinned'}`,
    `Agent runs: ${runs} (${definition.cases.length} case(s) × ${definition.execution.repetitions} repetition(s) × 2 variants)`,
  ];
  if (options.maxBudgetUsd !== undefined) {
    lines.push(`Budget:     at most $${options.maxBudgetUsd} per agent run (--max-budget-usd)`);
  }
  if (resolved.candidate.format === 'skill-md' && disablesModelInvocation(resolved.candidate)) {
    lines.push(
      'Note:       the skill sets disable-model-invocation, so Claude cannot invoke it on its own.',
    );
  }
  lines.push(
    '',
    options.authMode === 'subscription'
      ? `Cost:       ${runs} Claude Code sessions count against your Claude plan; other runs on the same plan share its rate limits.`
      : `Cost:       ${runs} Claude Code sessions are billed to your API key.`,
    'Data:       the prompt, the fixture files and the artifact are sent to Anthropic.',
    'Not sandboxed: the agent runs with your user permissions (file tools are confined to the workspace).',
  );
  if (options.authMode === 'subscription') {
    lines.push(
      'Ambient configuration: results may include user-level instructions from your ~/.claude.',
    );
  }
  if (input.runsCommands) {
    lines.push(
      '',
      input.storedApproved
        ? 'Commands (approved earlier for this suite version):'
        : 'Commands to approve for this suite version (--approve-commands):',
    );
    for (const testCase of definition.cases) {
      for (const command of testCase.setup) {
        lines.push(`  ${testCase.id} setup:     ${JSON.stringify(command)}`);
      }
      for (const assertion of testCase.assertions) {
        if (assertion.type === 'command') {
          lines.push(`  ${testCase.id} ${assertion.id}: ${JSON.stringify(assertion.command)}`);
        }
      }
    }
  }
  return lines;
}

interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** Sums the usage the agent runs reported; a total is null when no run reported it. */
export function usageTotals(detail: BenchmarkRunDetail): UsageTotals {
  const totals: UsageTotals = { inputTokens: null, outputTokens: null, costUsd: null };
  for (const run of detail.agentRuns) {
    const usage = run.usage as Partial<Record<keyof UsageTotals, number>> | null;
    for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      const value = usage?.[key];
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

type StoredSummary = ScoringSummary & {
  displayStatus: string;
  environment?: { agentProfile?: { executionModel?: string } };
};

export interface RunReport {
  runId: string;
  status: string;
  displayStatus: string;
  verdict: string | null;
  suite: { id: string; name: string; version: number };
  candidate: { artifact: string; version: number };
  baseline: { kind: 'none' } | { kind: 'artifact-version'; version: number };
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number | null;
  confidence: string | null;
  skillInvocation: ScoringSummary['skillInvocation'] | null;
  executionModel: string | null;
  warnings: string[];
  usage: UsageTotals & { cost: 'n/a (subscription)' | 'estimated' | 'not reported' };
  error: string | null;
}

/** The summary of FR-118-37, from the stored run (the same object `--json` prints). */
export function runReport(detail: BenchmarkRunDetail, authMode: ClaudeAuthMode): RunReport {
  const { run } = detail;
  const summary = run.summary as StoredSummary | null;
  const usage = usageTotals(detail);
  return {
    runId: run.id,
    status: run.status,
    displayStatus: summary?.displayStatus ?? (run.status === 'error' ? 'error' : run.status),
    verdict: run.verdict,
    suite: { id: detail.suite.slug, name: detail.suite.name, version: detail.suiteVersion.version },
    candidate: { artifact: detail.artifact.slug, version: detail.artifactVersion.version },
    baseline:
      detail.baselineArtifactVersion?.version == null
        ? { kind: 'none' }
        : { kind: 'artifact-version', version: detail.baselineArtifactVersion.version },
    baselineScore: summary?.baseline.meanScore ?? null,
    candidateScore: summary?.candidate.meanScore ?? null,
    delta: summary?.delta ?? null,
    confidence: summary?.confidence.level ?? null,
    skillInvocation: summary?.skillInvocation ?? null,
    executionModel: summary?.environment?.agentProfile?.executionModel ?? null,
    warnings: run.warnings,
    usage: {
      ...usage,
      ...(authMode === 'subscription' ? { costUsd: null } : {}),
      cost:
        authMode === 'subscription'
          ? 'n/a (subscription)'
          : usage.costUsd === null
            ? 'not reported'
            : 'estimated',
    },
    error: run.error,
  };
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** The human-readable summary (FR-118-37). */
export function reportText(report: RunReport): string[] {
  const baseline = report.baseline.kind === 'none' ? 'no artifact' : `v${report.baseline.version}`;
  const lines = [
    `Result:     ${report.displayStatus}${report.verdict ? ` (verdict: ${report.verdict}${report.confidence ? `, confidence: ${report.confidence}` : ''})` : ''}`,
    `Baseline (${baseline}):  score ${pct(report.baselineScore)}`,
    `Candidate (v${report.candidate.version}):  score ${pct(report.candidateScore)}`,
    `Delta:      ${report.delta === null ? '—' : `${report.delta > 0 ? '+' : ''}${(report.delta * 100).toFixed(1)} points`}`,
  ];
  if (report.skillInvocation) {
    const { baseline: b, candidate: c } = report.skillInvocation;
    lines.push(
      `Skill invoked: candidate ${c.invoked}/${c.runs} runs, baseline ${b.invoked}/${b.runs} runs${c.invoked === 0 ? ' — the result measures a skill that was never used' : ''}`,
    );
  }
  lines.push(`Model:      ${report.executionModel ?? 'not reported'}`);
  const tokens = (value: number | null) => (value === null ? 'not reported' : String(value));
  lines.push(
    `Tokens:     input ${tokens(report.usage.inputTokens)}, output ${tokens(report.usage.outputTokens)}`,
    `Cost:       ${report.usage.costUsd === null ? report.usage.cost : `$${report.usage.costUsd.toFixed(4)} (estimated)`}`,
  );
  for (const warning of report.warnings) lines.push(`Warning:    ${warning}`);
  if (report.error) lines.push(`Error:      ${report.error}`);
  lines.push(`Run id:     ${report.runId}`);
  return lines;
}

/** FR-118-38: 0 only for `passed`, 130 for a cancelled run, 6 for everything else. */
export function exitCodeFor(report: RunReport): number {
  if (report.status === 'cancelled') return ExitCode.Cancelled;
  return report.displayStatus === 'passed' ? ExitCode.Ok : ExitCode.CheckFailed;
}

/**
 * `directivebench benchmark run <suite> --artifact <ref> …` (SPEC-118 §6.4). Order of FR-118-39:
 * suite validation and fixture snapshot → artifact and baseline, bundle inspection and the
 * plan-time import scan → readiness → plan and confirmation → one transaction (suite version,
 * approval, acquired job) → the job in-process with the Claude Code adapter → summary. Every
 * refusal before the transaction leaves the data directory unchanged: the checks read an
 * initialised, fully migrated database read-only, and the data directory is opened for writing
 * only after the confirmation.
 */
export async function benchmarkRunCommand(
  flags: BenchmarkRunFlags,
  terminal: RunTerminal = processTerminal,
): Promise<number> {
  const options = parseRunFlags(flags);
  const path = definitionPath(options.suitePath);
  // With --json, stdout carries only the result object.
  const say = options.json ? console.error : console.log;
  const { migrationsDir } = resolveAssets();
  const preflight = openInitializedDatabase(flags.dataDir, migrationsDir);
  let handle = preflight.handle;
  // Fixture snapshots go to a temporary store first and reach `<dataDir>/fixtures` only once
  // the run is confirmed, so a refused or declined run leaves nothing behind (FR-118-39).
  const staging = await mkdtemp(join(tmpdir(), 'directivebench-suite-'));
  try {
    // An invalid config.json is refused now, not after the confirmation.
    readConfig(preflight.layout);
    const prepared = await loadSuite(path, staging);
    const resolved = await resolveVersions(handle.db, options);
    const { runsCommands, alreadyApproved } = await checkSuite(
      handle.db,
      prepared,
      resolved,
      options,
    );
    // `~` in an import resolves against the agent's HOME: the real one in Local Subscription
    // Mode, a fresh run-local (empty) one in API Key Mode.
    let home: string | null = null;
    if (options.authMode === 'subscription') {
      home = terminal.env.HOME ?? null;
      if (home === null) {
        throw new CliError(
          'Local Subscription Mode needs HOME, where Claude Code keeps its login.',
          ExitCode.Usage,
        );
      }
    }
    await inspectWorkspaces(prepared, resolved, staging, home);
    const readiness = await checkReadiness(options.authMode, terminal.env);

    for (const line of planText({
      prepared,
      resolved,
      options,
      agentVersion: readiness.version,
      storedApproved: alreadyApproved,
      runsCommands,
    })) {
      say(line);
    }
    if (!options.yes) {
      if (!terminal.interactive) {
        throw new CliError(
          'No terminal to confirm the run; review the plan and pass --yes to start it.',
          ExitCode.Usage,
        );
      }
      if (!(await terminal.confirm('Start the benchmark run?'))) {
        say('Not started; nothing was stored.');
        return ExitCode.Cancelled;
      }
    }

    // Confirmed: reopen for writing. The database is already migrated, so this only ensures the
    // data directory layout and config (`installationId`) the runner needs.
    handle.close();
    const workspace = await initialize(flags.dataDir, migrationsDir);
    const { layout, config } = workspace;
    handle = workspace.handle;
    for (const snapshot of prepared.snapshots) {
      // Content-addressed and idempotent: the same files give the same hash in the data store.
      await snapshotDirectory(join(staging, snapshot.hash), layout.fixtures);
    }
    // Only the adapter this suite needs; `serve` stays mock-only (FR-118-05).
    const adapters = new Map<string, AgentAdapter>([
      [
        CLAUDE_CODE_ADAPTER_ID,
        new ClaudeCodeAdapter(
          {
            authMode: options.authMode,
            ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
          },
          terminal.env,
        ),
      ],
    ]);
    const runner = new LocalRunner({
      handle,
      fixtureStore: layout.fixtures,
      cacheDir: layout.cache,
      adapters,
      keepWorkspaces: config.runner.keepWorkspaces,
      hostId: config.installationId,
    });

    const { definition } = prepared;
    let created;
    try {
      created = await createBenchmarkRunJob(handle, {
        fixtureVersions: prepared.snapshots.map((snapshot) => ({
          id: snapshot.hash,
          sourcePath: snapshot.sourcePath,
          fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes,
        })),
        suite: {
          slug: definition.id,
          name: definition.name,
          description: definition.description ?? null,
          schemaVersion: definition.schemaVersion,
          definition: definition as unknown as Record<string, unknown>,
          fixtures: prepared.fixtures,
          contentHash: prepared.contentHash,
          sourcePath: `${basename(dirname(prepared.sourcePath))}/${basename(prepared.sourcePath)}`,
        },
        approval: runsCommands && options.approveCommands && !alreadyApproved ? 'user' : null,
        payload: {
          artifactVersionId: resolved.candidate.versionId,
          ...(resolved.baseline ? { baselineArtifactVersionId: resolved.baseline.versionId } : {}),
          auth: { mode: options.authMode },
          ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        },
        runnerId: runner.runnerId,
      });
    } catch (error) {
      if (error instanceof InvalidBaselineError) throw new CliError(error.message, ExitCode.Usage);
      throw error;
    }

    say('');
    say(`Running ${definition.name} v${created.suite.version} with Claude Code… (Ctrl-C cancels)`);
    const stopListening = terminal.onInterrupt(() => {
      say('Cancelling…');
      runner.cancel(created.job.id);
    });
    let result;
    try {
      result = await runner.runAcquiredJob(created.job.id);
    } finally {
      stopListening();
    }
    if (result.benchmarkRunId === null) {
      throw new CliError(
        `The benchmark job ${result.status}: ${result.error}`,
        ExitCode.CheckFailed,
      );
    }
    const detail = (await getBenchmarkRunDetail(
      handle.db,
      result.benchmarkRunId,
    )) as BenchmarkRunDetail;
    if (detail.run.status === 'completed') {
      await assignBenchmarkSuite(handle.db, resolved.ref.artifact.id, created.suite.suiteId);
    }
    const report = runReport(detail, options.authMode);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      say('');
      for (const line of reportText(report)) say(line);
    }
    return exitCodeFor(report);
  } finally {
    await rm(staging, { recursive: true, force: true });
    handle.close();
  }
}
