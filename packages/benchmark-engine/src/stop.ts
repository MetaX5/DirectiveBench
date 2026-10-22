import type { ExecutionStatus, Variant } from './scoring';

/**
 * Agent-run error codes whose cause is systematic (SPEC-118 FR-118-15): every further agent run
 * would fail the same way and spend the user's login or quota, so the benchmark run stops after
 * the first one. The single place that decides which codes stop a run: adapters report a code in
 * `AgentRunResult.errorCode`, the engine copies it to `AgentRunRecord.errorCode`, and
 * {@link assertNotStopped} ends the orchestration loop. Extend this list (and SPEC-118 FR-118-15)
 * when a new systematic code appears.
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

/** Whether an agent run that ended with this code stops the benchmark run (FR-118-15). */
export function isStopCode(code: string | null): boolean {
  return code !== null && STOP_CODES.includes(code);
}

/**
 * A systematic agent-run failure ended the benchmark run before its remaining agent runs: no
 * further setup, installation or adapter call happened. The runner records the benchmark run as
 * `error` with this message; `code` is the agent run's stop code.
 */
export class BenchmarkStoppedError extends Error {
  override name = 'BenchmarkStoppedError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The agent-run facts {@link assertNotStopped} reads. */
export interface StopFacts {
  caseId: string;
  variant: Variant;
  repetition: number;
  executionStatus: ExecutionStatus;
  error: string | null;
  errorCode: string | null;
}

/** Throws {@link BenchmarkStoppedError} when the agent run ended with a stop code (FR-118-15). */
export function assertNotStopped(record: StopFacts): void {
  if (!isStopCode(record.errorCode)) return;
  throw new BenchmarkStoppedError(
    record.errorCode as string,
    `Stopped after case ${record.caseId}, ${record.variant} repetition ${record.repetition} (${record.errorCode}): ${record.error ?? 'no detail'}. No further agent runs were started.`,
  );
}
