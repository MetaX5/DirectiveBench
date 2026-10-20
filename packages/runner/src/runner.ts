import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
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
  interruptJobs,
  isCancellationRequested,
  recoverStaleJobs,
  repositoryRegistrationPayloadSchema,
  repositoryScanPayloadSchema,
  type DatabaseHandle,
  type JobRecord,
  type JobType,
} from '@directivebench/database';
import { RegistrationCancelledError, registerLocalPath } from './repository-registration';
import { ScanCancelledError, scanLocalRepository } from './repository-scan';

/**
 * The runner's lanes (SPEC-114, SPEC-104 OQ-104-06): `runner.concurrency` slots for long jobs —
 * benchmark runs and repository scans, whose duration grows with the work — plus one slot for
 * short jobs, so a registration never waits behind a running benchmark or scan.
 */
type Lane = 'long' | 'short';
const LANE_JOB_TYPES: Record<Lane, readonly JobType[]> = {
  long: ['benchmark-run', 'repository-scan'],
  short: ['repository-registration'],
};
/** Slots of the short lane, in addition to `concurrency`. */
export const SHORT_JOB_SLOTS = 1;

/**
 * How long `stop()` waits, once its deadline has passed, to mark the jobs that did not stop as
 * `interrupted`. The write can wait behind a transaction a job still holds on the shared
 * connection; past this grace `stop()` returns without it, and the first runner start after
 * their heartbeat went stale recovers the jobs left `running` (`recoverStaleJobs`, SPEC-114).
 */
export const SHUTDOWN_INTERRUPT_GRACE_MS = 1000;

/** Structured context attached to runner log events (job id, event name, …). */
export type RunnerLogFields = Record<string, string | number | boolean | null>;

export interface RunnerLogger {
  info(message: string, fields?: RunnerLogFields): void;
  error(message: string, fields?: RunnerLogFields): void;
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
  /** Maximum time graceful shutdown waits for running jobs (FR-114-13, default 10 s). */
  shutdownTimeoutMs?: number;
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
 * Executes jobs from the SQLite queue with bounded concurrency: benchmark runs, repository
 * registrations (SPEC-104 §9) and repository scans (SPEC-105, local repositories). It runs
 * inside the CLI process; the web UI only enqueues jobs.
 * Remote runners will implement the same lifecycle over an authenticated outbound connection
 * (see .ai/specs/2026-10-14-runner-management.md).
 */
export class LocalRunner {
  readonly runnerId = `local-${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  private readonly options: Required<Omit<LocalRunnerOptions, 'logger'>> & { logger: RunnerLogger };
  private readonly active = new Map<
    string,
    { lane: Lane; controller: AbortController; done: Promise<JobExecutionResult> }
  >();
  /** Result lists of `runUntilIdle` calls in progress; every finished job is appended. */
  private readonly finished = new Set<JobExecutionResult[]>();
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** The poll in progress, so `stop()` can wait for a job it is acquiring right now. */
  private polling: Promise<void> | null = null;

  constructor(options: LocalRunnerOptions) {
    this.options = {
      concurrency: 1,
      keepWorkspaces: false,
      workspaceRoot: join(tmpdir(), 'directivebench', 'workspaces'),
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 5000,
      staleAfterMs: 30_000,
      shutdownTimeoutMs: 10_000,
      logger: silentLogger,
      ...options,
    };
  }

  /** Marks jobs orphaned by a crashed runner as interrupted. Called on start. */
  async recover(): Promise<string[]> {
    const staleBefore = new Date(Date.now() - this.options.staleAfterMs).toISOString();
    const recovered = await recoverStaleJobs(this.options.handle.db, staleBefore);
    if (recovered.length > 0) {
      this.options.logger.info(`Marked ${recovered.length} orphaned job(s) as interrupted`, {
        event: 'recovered',
        jobIds: recovered.join(','),
      });
    }
    return recovered;
  }

  async start(): Promise<void> {
    // Reset before awaiting so a stop() that lands during recovery is not undone.
    this.stopping = false;
    await this.recover();
    const tick = () => {
      if (this.stopping) return;
      void this.poll().finally(() => {
        if (!this.stopping) this.pollTimer = setTimeout(tick, this.options.pollIntervalMs);
      });
    };
    tick();
  }

  /**
   * Claims jobs until both lanes are full or have nothing pending: up to `concurrency` long jobs
   * and up to {@link SHORT_JOB_SLOTS} short ones, each lane in FIFO order.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = (async () => {
      try {
        await this.fill('long', this.options.concurrency);
        await this.fill('short', SHORT_JOB_SLOTS);
      } catch (error) {
        this.options.logger.error(`Runner poll failed: ${(error as Error).message}`, {
          event: 'poll-failed',
        });
      } finally {
        this.polling = null;
      }
    })();
    await this.polling;
  }

  private laneSize(lane: Lane): number {
    return [...this.active.values()].filter((job) => job.lane === lane).length;
  }

  private async fill(lane: Lane, slots: number): Promise<void> {
    while (!this.stopping && this.laneSize(lane) < slots) {
      const job = await acquireNextJob(this.options.handle.db, this.runnerId, {
        types: LANE_JOB_TYPES[lane],
      });
      if (!job) return;
      this.options.logger.info(`Job ${job.id} acquired`, { event: 'acquired', jobId: job.id });
      const controller = new AbortController();
      // Claimed after `stop()` gave up waiting for this poll: interrupt it instead of running it.
      if (this.stopping) controller.abort('shutdown');
      const done = this.execute(job, controller)
        .then((result) => {
          for (const results of this.finished) results.push(result);
          return result;
        })
        .finally(() => this.active.delete(job.id));
      this.active.set(job.id, { lane, controller, done });
    }
  }

  /** Processes the queue until no job is pending or running. Used by `directivebench demo` and tests. */
  async runUntilIdle(): Promise<JobExecutionResult[]> {
    // Collected as jobs finish, so a job that completes while `poll` is still filling the other
    // lane — and is gone from `active` by the time `poll` returns — is not lost.
    const results: JobExecutionResult[] = [];
    this.finished.add(results);
    try {
      for (;;) {
        await this.poll();
        if (this.active.size === 0) return results;
        await Promise.race([...this.active.values()].map((a) => a.done));
      }
    } finally {
      this.finished.delete(results);
    }
  }

  /**
   * Graceful shutdown: stops polling, waits for a poll in flight to finish claiming, aborts
   * running jobs and waits for them — all within `shutdownTimeoutMs`. Aborted jobs are recorded
   * as `interrupted` (not user-cancelled); jobs that did not stop in time are marked
   * `interrupted` directly, waiting at most {@link SHUTDOWN_INTERRUPT_GRACE_MS} more for that
   * write, and a job claimed after the deadline is aborted as soon as it is.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.options.shutdownTimeoutMs);
    });
    // A job claimed by a poll that is still in flight would otherwise start after the abort below
    // and run unsupervised. `fill` checks `stopping` before each claim, so this ends promptly
    // unless the claim waits behind a transaction.
    const claimTimedOut = await Promise.race([
      Promise.resolve(this.polling).then(() => false),
      deadline,
    ]);
    const running = [...this.active.entries()];
    for (const [, { controller }] of running) controller.abort('shutdown');
    const timedOut =
      claimTimedOut ||
      (await Promise.race([
        Promise.allSettled(running.map(([, a]) => a.done)).then(() => false),
        deadline,
      ]));
    clearTimeout(timer);
    if (timedOut) await this.interruptRemaining();
  }

  /**
   * Marks the jobs still active after the shutdown deadline as `interrupted`, waiting at most
   * {@link SHUTDOWN_INTERRUPT_GRACE_MS}: the write can wait behind a transaction one of those
   * jobs holds. A write that misses the grace is not cancelled. For an in-process caller that
   * keeps the database open, it lands once that transaction ends. Under `serve`, which closes the
   * database right after `stop()`, it fails; that is logged as information, not as an error,
   * because shutdown has already reported the jobs as left `running`, and a runner start after
   * their heartbeat went stale (> 30 s) recovers them as `interrupted` (`recoverStaleJobs`).
   */
  private async interruptRemaining(): Promise<void> {
    const { handle, logger } = this.options;
    const jobIds = [...this.active.keys()];
    let graceExpired = false;
    const marking = interruptJobs(handle.db, jobIds, 'Runner shut down before the job stopped')
      // Handled here, not left to reject unobserved after `stop()` has returned.
      .catch((error: unknown) => {
        // Drizzle wraps the SQLite error in "Failed query: … params: …"; its cause says why.
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (graceExpired) {
          logger.info(
            `The late write marking jobs as interrupted after shutdown did not land (${reason}); a later runner start recovers them`,
            { event: 'shutdown-interrupt-abandoned', jobIds: jobIds.join(',') },
          );
        } else {
          logger.error(`Shutdown could not mark jobs as interrupted: ${reason}`, {
            event: 'shutdown-interrupt-failed',
            jobIds: jobIds.join(','),
          });
        }
        return null;
      });
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace-expired'>((resolve) => {
      timer = setTimeout(() => resolve('grace-expired'), SHUTDOWN_INTERRUPT_GRACE_MS);
    });
    const ids = await Promise.race([marking, grace]);
    clearTimeout(timer);
    if (ids === 'grace-expired') {
      graceExpired = true;
      logger.error(
        `Shutdown timed out; ${jobIds.length} job(s) stay running until a later runner start recovers them as interrupted`,
        { event: 'shutdown-interrupt-skipped', jobIds: jobIds.join(',') },
      );
    } else if (ids !== null) {
      logger.error(`Shutdown timed out; marked ${ids.length} job(s) as interrupted`, {
        event: 'shutdown-timeout',
        jobIds: ids.join(','),
      });
    }
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
        if (!controller.signal.aborted && (await isCancellationRequested(db, job.id))) {
          logger.info(`Job ${job.id} cancellation requested`, {
            event: 'cancel-observed',
            jobId: job.id,
          });
          controller.abort('cancelled');
        }
      })().catch((error: unknown) =>
        logger.error(`Heartbeat failed for ${job.id}: ${(error as Error).message}`, {
          event: 'heartbeat-failed',
          jobId: job.id,
        }),
      );
    }, this.options.heartbeatIntervalMs);

    const finishAs = async (
      status: JobExecutionResult['status'],
      error: string | null,
      result?: Record<string, unknown>,
    ): Promise<JobExecutionResult> => {
      await finishJob(db, job.id, status, error ?? undefined, result);
      logger.info(`Job ${job.id} ${status}${error ? `: ${error}` : ''}`, {
        event: 'finished',
        jobId: job.id,
        status,
        benchmarkRunId,
      });
      return { jobId: job.id, status, benchmarkRunId, error };
    };

    try {
      if (job.type === 'repository-registration') {
        const payload = repositoryRegistrationPayloadSchema.safeParse(job.payload);
        if (!payload.success) {
          const reasons = payload.error.issues.map((issue) => issue.message).join(' ');
          return await finishAs('failed', `The stored registration request is invalid: ${reasons}`);
        }
        const result = await registerLocalPath(
          handle,
          { path: payload.data.path, confirmedLocation: payload.data.confirmedLocation ?? null },
          { homeDir: homedir(), env: process.env, signal: controller.signal },
        );
        return await finishAs('completed', null, result);
      }
      if (job.type === 'repository-scan') {
        const payload = repositoryScanPayloadSchema.safeParse(job.payload);
        if (!payload.success) {
          const reasons = payload.error.issues.map((issue) => issue.message).join(' ');
          return await finishAs('failed', `The stored scan request is invalid: ${reasons}`);
        }
        const result = await scanLocalRepository(
          handle,
          { jobId: job.id, repositoryId: payload.data.repositoryId },
          { signal: controller.signal, homeDir: homedir(), env: process.env },
        );
        // A scan that could not run is a failed job; its typed outcome stays in `jobs.result`.
        return result.ok
          ? await finishAs('completed', null, result)
          : await finishAs('failed', result.message, result);
      }
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
      if (error instanceof RegistrationCancelledError || error instanceof ScanCancelledError) {
        return await finishAs(
          controller.signal.reason === 'shutdown' ? 'interrupted' : 'cancelled',
          null,
        );
      }
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
