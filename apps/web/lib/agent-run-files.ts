// Display logic of the "Output files" card on the run page and of the agent-run files page
// (SPEC-123 FR-123-20, FR-123-21, decisions D21 to D34). Pure functions over repository rows, so
// the pages stay presentational and every rule is unit-tested.

import { z } from 'zod';
import { formatSize } from './output-files';

/** The agent-run fields these rules read (a subset of the repository row). */
export interface AgentRunOutputState {
  executionStatus: string;
  passed: boolean | null;
  outputFilesKept: boolean;
  /** Redacted reason when the files were not kept; null when kept and for pre-capture rows. */
  outputFilesReason: string | null;
  changedFiles: readonly unknown[];
}

/** The per-agent-run counts of `countAgentRunFiles` (no content). */
export interface AgentRunFileCountsView {
  files: number;
  truncated: number;
  notKept: number;
  storedBytes: number;
}

export type AgentRunBadgeVariant = 'success' | 'destructive' | 'muted';

/**
 * The execution status of an agent run as the run page's "Agent runs" section shows it: a
 * completed run says whether it passed, any other run its execution status (D23).
 */
export function agentRunStatusBadge(run: Pick<AgentRunOutputState, 'executionStatus' | 'passed'>): {
  label: string;
  variant: AgentRunBadgeVariant;
} {
  const variant = run.passed ? 'success' : run.passed === false ? 'destructive' : 'muted';
  if (run.executionStatus !== 'completed') return { label: run.executionStatus, variant };
  return { label: run.passed ? 'passed' : 'failed', variant };
}

/** "Candidate (v3), repetition 2" (SPEC-123 §11, D23, D28). */
export function agentRunLabel(variantLabel: string, repetition: number): string {
  return `${variantLabel}, repetition ${repetition}`;
}

/** An agent run stored before output-file capture existed: not kept and no reason (D26). */
export function predatesCapture(
  run: Pick<AgentRunOutputState, 'outputFilesKept' | 'outputFilesReason'>,
): boolean {
  return !run.outputFilesKept && run.outputFilesReason === null;
}

/** True when the card shows only "Output files were not kept for this run." (FR-123-20, D26). */
export function wholeRunPredatesCapture(
  runs: readonly Pick<AgentRunOutputState, 'outputFilesKept' | 'outputFilesReason'>[],
): boolean {
  return runs.length > 0 && runs.every(predatesCapture);
}

/** A stored reason as the end of a sentence: without a final period, which the copy adds. */
function reasonText(reason: string): string {
  return reason.trim().replace(/\.+$/, '');
}

/** The cells of one agent run's row in the "Output files" card (D23, D25). */
export interface OutputFilesRow {
  changedFiles: number;
  kept: string;
  notComplete: string;
}

export function outputFilesRow(
  run: AgentRunOutputState,
  counts: AgentRunFileCountsView | undefined,
): OutputFilesRow {
  if (!run.outputFilesKept) {
    return {
      changedFiles: run.changedFiles.length,
      kept: 'Not kept',
      notComplete:
        run.outputFilesReason === null
          ? 'Not kept: this agent run predates output file capture.'
          : `Not kept: ${reasonText(run.outputFilesReason)}.`,
    };
  }
  const parts = [
    ...(counts?.truncated ? [`${counts.truncated} truncated`] : []),
    ...(counts?.notKept ? [`${counts.notKept} not kept`] : []),
  ];
  return {
    changedFiles: counts?.files ?? 0,
    kept: formatSize(counts?.storedBytes ?? 0),
    notComplete: parts.length ? parts.join(', ') : 'None',
  };
}

/**
 * The sentence the files page shows instead of a file list (D34): the agent changed nothing, or
 * the files were not kept and why. Null when there are files to list.
 */
export function agentRunFilesNotice(
  run: Pick<AgentRunOutputState, 'outputFilesKept' | 'outputFilesReason'>,
  fileCount: number,
): string | null {
  if (run.outputFilesKept) return fileCount === 0 ? 'The agent did not change any file.' : null;
  if (run.outputFilesReason === null) return 'Output files were not kept for this agent run.';
  return `Output files were not kept: ${reasonText(run.outputFilesReason)}.`;
}

/** One non-empty `?path=`; empty or repeated values count as absent (D33). */
const pathParamSchema = z.string().min(1);

export function parsePathParam(value: string | string[] | undefined): string | null {
  const parsed = pathParamSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type FileSelection =
  { kind: 'file'; path: string } | { kind: 'none' } | { kind: 'not-found' };

/**
 * The file to show (D32, D33): the requested path when it is listed, the first file when none
 * was requested, none when the agent run lists no file, and not found for a path it does not list.
 */
export function selectFile(paths: readonly string[], requested: string | null): FileSelection {
  if (requested === null) {
    const first = paths[0];
    return first === undefined ? { kind: 'none' } : { kind: 'file', path: first };
  }
  return paths.includes(requested) ? { kind: 'file', path: requested } : { kind: 'not-found' };
}

/** The URL of an agent run's files page, optionally with a selected file. */
export function agentRunFilesHref(
  benchmarkRunId: string,
  agentRunId: string,
  path?: string,
): string {
  const base = `/results/${encodeURIComponent(benchmarkRunId)}/agent-runs/${encodeURIComponent(agentRunId)}`;
  return path === undefined ? base : `${base}?${new URLSearchParams({ path }).toString()}`;
}
