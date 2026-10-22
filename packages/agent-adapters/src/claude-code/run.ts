import type { WorkspacePin } from '../workspace-pin';
import {
  abortedByTimeout,
  runClaudeProcess,
  type ClaudeProcessInput,
  type ClaudeProcessResult,
} from './process';
import {
  inspectWorkspace,
  type WorkspaceFinding,
  type WorkspaceInspectionCode,
} from './workspace-inspection';

/** Findings named in a refusal message; the full list stays in `findings`. */
export const REFUSAL_FINDINGS_SHOWN = 10;

export interface ClaudeRunInput extends Omit<ClaudeProcessInput, 'cwd'> {
  /** The workspace pinned before `setup`; `claude` runs in its canonical path. */
  workspace: WorkspacePin;
  /** What the installation wrote, exempt from the configuration check only (FR-118-06). */
  installedPaths: readonly string[];
}

/** Codes of a run the process layer ended, beyond the workspace inspection codes. */
export type ClaudeProcessErrorCode =
  /** `claude` could not be started (SPEC-203 §9). */
  | 'spawn-failed'
  /** stdout exceeded `CLAUDE_STDOUT_MAX_BYTES`; the run was stopped. */
  | 'output-limit'
  /** Processes of `claude`'s group survived the kill after it exited (SPEC-118 §12). */
  | 'stray-processes';

/**
 * Why the process layer ended a run, or null in {@link ClaudeRunOutcome.ended} when `claude` ran
 * to its own exit and the stream parser decides the status from the output.
 */
export interface ClaudeRunEnd {
  status: 'cancelled' | 'timeout' | 'agent-error' | 'infrastructure-error';
  errorCode: WorkspaceInspectionCode | ClaudeProcessErrorCode | null;
  message: string;
}

export type ClaudeRunOutcome =
  /** No process was started: refused by the inspection, or cancelled or timed out first. */
  | {
      ended: ClaudeRunEnd;
      /** Findings of the pre-spawn inspection; non-empty only when it refused the run. */
      findings: WorkspaceFinding[];
      process: null;
    }
  /** `claude` was started (or its spawn failed); `ended` is null when the parser decides. */
  | { ended: ClaudeRunEnd | null; findings: []; process: ClaudeProcessResult };

function refusalMessage(findings: readonly WorkspaceFinding[]): string {
  const shown = findings.slice(0, REFUSAL_FINDINGS_SHOWN).map((finding) => {
    const extra = [finding.token, finding.target].filter((part) => part !== undefined);
    return `${finding.path}: ${finding.detail}${extra.length > 0 ? ` (${extra.join(' → ')})` : ''}`;
  });
  const more = findings.length - shown.length;
  return [
    `The workspace was refused before claude started: ${shown.join('; ')}`,
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join(' ');
}

/** Maps a process result to the end the process layer decides, or null for the parser. */
export function claudeProcessEnd(result: ClaudeProcessResult): ClaudeRunEnd | null {
  // First: survivors can change the workspace whatever else happened, and the code stops the run.
  if (result.strayProcesses) {
    return {
      status: 'infrastructure-error',
      errorCode: 'stray-processes',
      message: 'Processes claude started could not be stopped after it exited.',
    };
  }
  if (result.cancelled) return { status: 'cancelled', errorCode: null, message: 'Cancelled' };
  if (result.timedOut) {
    return { status: 'timeout', errorCode: null, message: 'claude did not finish in time' };
  }
  if (!result.spawned) {
    return {
      status: 'infrastructure-error',
      errorCode: 'spawn-failed',
      message: `claude could not be started: ${result.error}`,
    };
  }
  if (result.outputLimitExceeded) {
    return {
      status: 'agent-error',
      errorCode: 'output-limit',
      message: 'claude wrote more output than the limit; the run was stopped.',
    };
  }
  return null;
}

/**
 * One agent run of `claude` in a pinned workspace (SPEC-118 FR-118-01): no process is started
 * after cancellation; the workspace is inspected right before the spawn (FR-118-06 configuration
 * written by `setup`, FR-118-27 imports and links, a replaced workspace), with `~` resolved
 * against the agent's own `HOME`, and any finding ends the run `infrastructure-error` with the
 * finding's code, which stops the benchmark run (FR-118-15); otherwise `claude` runs under
 * {@link runClaudeProcess}. `ended` is set when the outcome needs no stream parsing.
 */
export async function runClaudeCode(input: ClaudeRunInput): Promise<ClaudeRunOutcome> {
  const home = input.env.HOME;
  if (home === undefined) throw new Error('The claude environment must set HOME.');
  const notStarted = (): ClaudeRunOutcome => ({
    ended: abortedByTimeout(input.signal)
      ? { status: 'timeout', errorCode: null, message: 'Timed out before claude started' }
      : { status: 'cancelled', errorCode: null, message: 'Cancelled before claude started' },
    findings: [],
    process: null,
  });
  if (input.signal.aborted) return notStarted();
  const findings = await inspectWorkspace(input.workspace, {
    homeDir: home,
    installedPaths: input.installedPaths,
  });
  const [first] = findings;
  if (first) {
    return {
      ended: {
        status: 'infrastructure-error',
        errorCode: first.code,
        message: refusalMessage(findings),
      },
      findings,
      process: null,
    };
  }
  // The inspection takes time: a cancellation during it must not start the agent.
  if (input.signal.aborted) return notStarted();
  const result = await runClaudeProcess({
    executable: input.executable,
    argv: input.argv,
    env: input.env,
    cwd: input.workspace.canonical,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    ...(input.killGraceMs === undefined ? {} : { killGraceMs: input.killGraceMs }),
  });
  return { ended: claudeProcessEnd(result), findings: [], process: result };
}
