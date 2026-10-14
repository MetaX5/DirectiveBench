import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '@directivebench/agent-adapters';
import {
  BenchmarkCancelledError,
  BenchmarkConfigurationError,
  displayStatus,
  runBenchmark,
  validateDefinition,
  type AgentRunRecord,
} from '@directivebench/benchmark-engine';
import {
  acquireNextJob,
  benchmarkJobPayloadSchema,
  createBenchmarkRun,
  finishBenchmarkRun,
  finishJob,
  getArtifactBundle,
  getSuiteVersion,
  heartbeatJob,
  insertAgentRun,
  isCancellationRequested,
  recoverStaleJobs,
  type DatabaseHandle,
  type JobRecord,
} from '@directivebench/database';

export interface RunnerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface LocalRunnerOptions {
  handle: DatabaseHandle;
  /** `<dataDir>/fixtures` */
  fixtureStore: string;
  adapters: Map<string, AgentAdapter>;
  concurrency?: number;
  keepWorkspaces?: boolean;
  /** Root for temporary workspaces. Default: `<os tmp>/directivebench/workspaces`. */
  workspaceRoot?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Running jobs whose heartbeat is older than this are considered orphaned. */
  staleAfterMs?: number;
  logger?: RunnerLogger;
}

export interface JobExecutionResult {
  jobId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  benchmarkRunId: string | null;
  error: string | null;
}

const silentLogger: RunnerLogger = { info: () => undefined, error: () => undefined };

/**
 * Executes benchmark jobs from the SQLite queue with bounded concurrency. It runs inside the CLI
 * process; the web UI only enqueues jobs. Remote runners will implement the same lifecycle over
 * an authenticated outbound connection (see .ai/specs/features/runner-management.md).
 */
export class LocalRunner {
  readonly runnerId = `runner_${randomBytes(6).toString('hex')}`;
  private readonly options: Required<Omit<LocalRunnerOptions, 'logger'>> & { logger: RunnerLogger };
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<JobExecutionResult> }
  >();
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private polling = false;

  constructor(options: LocalRunnerOptions) {
    this.options = {
      concurrency: 1,
      keepWorkspaces: false,
      workspaceRoot: join(tmpdir(), 'directivebench', 'workspaces'),
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 5000,
      staleAfterMs: 30_000,
      logger: silentLogger,
      ...options,
    };
  }

  /** Marks jobs orphaned by a crashed runner as interrupted. Called on start. */
  async recover(): Promise<string[]> {
    const staleBefore = new Date(Date.now() - this.options.staleAfterMs).toISOString();
    const recovered = await recoverStaleJobs(this.options.handle.db, staleBefore);
    if (recovered.length > 0) {
      this.options.logger.info(`Marked ${recovered.length} orphaned job(s) as interrupted`);
    }
    return recovered;
  }

  async start(): Promise<void> {
    await this.recover();
    this.stopping = false;
    const tick = () => {
      if (this.stopping) return;
      void this.poll().finally(() => {
        if (!this.stopping) this.pollTimer = setTimeout(tick, this.options.pollIntervalMs);
      });
    };
    tick();
  }

  /** Claims jobs until the concurrency limit is reached or the queue is empty. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      while (!this.stopping && this.active.size < this.options.concurrency) {
        const job = await acquireNextJob(this.options.handle.db, this.runnerId);
        if (!job) break;
        const controller = new AbortController();
        const done = this.execute(job, controller).finally(() => this.active.delete(job.id));
        this.active.set(job.id, { controller, done });
      }
    } catch (error) {
      this.options.logger.error(`Runner poll failed: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Processes the queue until no job is pending or running. Used by `directivebench demo` and tests. */
  async runUntilIdle(): Promise<JobExecutionResult[]> {
    const results: JobExecutionResult[] = [];
    for (;;) {
      await this.poll();
      if (this.active.size === 0) return results;
      results.push(await Promise.race([...this.active.values()].map((a) => a.done)));
    }
  }

  /**
   * Graceful shutdown: stops polling, aborts running jobs and waits for them. Aborted jobs are
   * recorded as `interrupted` (not user-cancelled).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const { controller } of this.active.values()) controller.abort('shutdown');
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  get activeJobCount(): number {
    return this.active.size;
  }

  private async execute(job: JobRecord, controller: AbortController): Promise<JobExecutionResult> {
    const { handle, logger } = this.options;
    const db = handle.db;
    let benchmarkRunId: string | null = null;

    const heartbeat = setInterval(() => {
      void (async () => {
        await heartbeatJob(db, job.id);
        if (await isCancellationRequested(db, job.id)) controller.abort('cancelled');
      })().catch((error: unknown) =>
        logger.error(`Heartbeat failed for ${job.id}: ${(error as Error).message}`),
      );
    }, this.options.heartbeatIntervalMs);

    const finishAs = async (
      status: JobExecutionResult['status'],
      error: string | null,
    ): Promise<JobExecutionResult> => {
      await finishJob(db, job.id, status, error ?? undefined);
      logger.info(`Job ${job.id} ${status}${error ? `: ${error}` : ''}`);
      return { jobId: job.id, status, benchmarkRunId, error };
    };

    try {
      logger.info(`Job ${job.id} started`);
      const payload = benchmarkJobPayloadSchema.parse(job.payload);
      const suiteVersion = await getSuiteVersion(db, payload.suiteVersionId);
      const artifact = await getArtifactBundle(db, payload.artifactVersionId);
      if (!suiteVersion || !artifact)
        return await finishAs('failed', 'Suite or artifact version no longer exists');

      const validation = validateDefinition(suiteVersion.version.definition);
      if (!validation.success) {
        return await finishAs(
          'failed',
          `Stored definition is invalid: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
        );
      }
      const definition = validation.definition;
      const adapter = this.options.adapters.get(definition.execution.agent);
      if (!adapter) {
        return await finishAs(
          'failed',
          `Agent "${definition.execution.agent}" cannot execute benchmarks in this build (only: ${[...this.options.adapters.keys()].join(', ')}).`,
        );
      }
      const detection = await adapter.detect();
      benchmarkRunId = await createBenchmarkRun(db, {
        jobId: job.id,
        suiteVersionId: suiteVersion.version.id,
        artifactVersionId: artifact.versionId,
        agentAdapterId: adapter.id,
        agentVersion: detection.version,
        model: definition.execution.model,
        environment: { kind: definition.execution.environment.kind },
      });
      const runId = benchmarkRunId;

      try {
        const outcome = await runBenchmark({
          definition,
          fixtures: suiteVersion.version.fixtures,
          fixtureStore: this.options.fixtureStore,
          artifact,
          adapter,
          workRoot: join(this.options.workspaceRoot, runId),
          keepWorkspaces: this.options.keepWorkspaces,
          executionApproved: Boolean(suiteVersion.version.executionApprovedAt),
          signal: controller.signal,
          onAgentRun: (record) => this.persistAgentRun(runId, record),
        });
        await finishBenchmarkRun(db, runId, {
          status: 'completed',
          verdict: outcome.summary.verdict,
          summary: {
            ...outcome.summary,
            environment: outcome.environment,
            displayStatus: displayStatus(outcome.summary.verdict, outcome.summary.candidateOutcome),
          },
          comparabilityKey: outcome.comparabilityKey,
          warnings: outcome.warnings,
          error: null,
        });
        return await finishAs('completed', null);
      } catch (error) {
        if (error instanceof BenchmarkCancelledError || controller.signal.aborted) {
          const shutdown = controller.signal.reason === 'shutdown';
          await finishBenchmarkRun(db, runId, {
            status: shutdown ? 'interrupted' : 'cancelled',
            verdict: null,
            summary: null,
            comparabilityKey: null,
            warnings: [],
            error: shutdown ? 'Runner shut down during execution' : 'Cancelled by user',
          });
          return await finishAs(shutdown ? 'interrupted' : 'cancelled', null);
        }
        const message = error instanceof Error ? error.message : String(error);
        await finishBenchmarkRun(db, runId, {
          status: 'error',
          verdict: 'error',
          summary: null,
          comparabilityKey: null,
          warnings: [],
          error: message,
        });
        return await finishAs(
          'failed',
          error instanceof BenchmarkConfigurationError ? message : `Benchmark failed: ${message}`,
        );
      }
    } catch (error) {
      return await finishAs('failed', error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async persistAgentRun(benchmarkRunId: string, record: AgentRunRecord): Promise<void> {
    await insertAgentRun(this.options.handle, {
      benchmarkRunId,
      caseId: record.caseId,
      variant: record.variant,
      repetition: record.repetition,
      fixtureVersionId: record.fixtureHash,
      executionStatus: record.executionStatus,
      score: record.score,
      passed: record.passed,
      durationMs: record.durationMs,
      changedFiles: record.changedFiles,
      trace: record.trace,
      usage: record.usage,
      error: record.error,
      assertions: record.assertions.map((a) => ({
        assertionId: a.assertionId,
        type: a.type,
        passed: a.passed,
        score: a.score,
        weight: a.weight,
        required: a.required,
        deterministic: a.deterministic,
        message: a.message,
        details: a.details,
      })),
    });
  }
}
