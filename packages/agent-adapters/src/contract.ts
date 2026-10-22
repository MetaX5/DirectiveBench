import type { ArtifactBundle, ModelSelection } from '@directivebench/core';
import type { WorkspacePin } from './workspace-pin';

/**
 * Capability flags describe what an adapter can do. The engine checks capabilities instead of
 * assuming every harness behaves like another (Claude Code, Codex and Cursor differ).
 */
export interface AgentCapabilities {
  /** The adapter can execute tasks in this build (false for detection-only adapters). */
  execution: boolean;
  /** Non-interactive, single-task execution in a working directory. */
  headless: boolean;
  /** The harness accepts an explicit model selection. */
  modelSelection: boolean;
  /** Installs skills/instructions/rules into a workspace using the harness's conventions. */
  artifactInstallation: boolean;
  /** Structured (JSON) result/trace output is available. */
  structuredOutput: boolean;
  /** Token usage or cost is reported. */
  usageReporting: boolean;
  /** Behaviour is deterministic for identical inputs. */
  deterministic: boolean;
}

export type AuthReadiness = 'ready' | 'not-required' | 'unknown' | 'missing';

/** Whether an agent can run in one auth mode (e.g. `subscription`, `api-key`). */
export interface AgentModeReadiness {
  mode: string;
  ready: boolean;
  /** Error code (e.g. SPEC-203 §9 `auth-missing`) when not ready, otherwise null. */
  code: string | null;
  /** Explanation for the user; never contains a secret or raw command output. */
  detail: string;
}

export interface AgentDetection {
  adapterId: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  /**
   * Authentication state when it can be determined without reading credential files: `ready`
   * when at least one auth mode in `readiness` is ready, `missing` when none is.
   */
  auth: AuthReadiness;
  /** Per-auth-mode readiness, for agents whose readiness check is implemented. */
  readiness?: AgentModeReadiness[];
  notes: string[];
}

export type TraceEvent =
  | { type: 'context-loaded'; files: string[] }
  | { type: 'step-applied'; stepId: string; description: string }
  | { type: 'step-skipped'; stepId: string; description: string; reason: string }
  | { type: 'file-written'; path: string; bytes: number }
  | { type: 'message'; text: string }
  | { type: 'error'; message: string };

export interface AgentRunRequest {
  /**
   * The run workspace, pinned by the engine when it was created and before any `setup` command
   * ran (SPEC-118 §12). The agent runs in this workspace; adapters that inspect or write it
   * check the pin first.
   */
  workspace: WorkspacePin;
  /** Workspace-relative paths `installArtifact` wrote for this run; empty when none was installed. */
  installedPaths: readonly string[];
  /**
   * A private, empty, run-local directory outside the workspace (absolute) for the adapter's own
   * files, such as an isolated home or temporary directory. Removed with the run.
   */
  scratchDir: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  model: ModelSelection | null;
  /** Adapter-specific options from the benchmark case (`agentOptions[adapterId]`). */
  options: unknown;
}

/**
 * `infrastructure-error`: the run could not take place for a reason outside the agent's behaviour,
 * e.g. the pre-spawn workspace inspection refused it (SPEC-118 FR-118-06/27).
 */
export type AgentExecutionStatus =
  'completed' | 'agent-error' | 'timeout' | 'cancelled' | 'infrastructure-error';

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentRunResult {
  status: AgentExecutionStatus;
  durationMs: number;
  summary: string;
  trace: TraceEvent[];
  usage: AgentUsage | null;
  error: string | null;
  /**
   * Machine-readable failure code (SPEC-203 §9), when the adapter has one. The engine stops the
   * benchmark run after a code in its FR-118-15 stop list (`STOP_CODES`).
   */
  errorCode?: string;
}

export interface InstalledArtifact {
  /** Workspace-relative paths written by the installation. */
  paths: string[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentDetection>;
  /**
   * Installs one exact artifact version into the pinned workspace (candidate, and an A/B
   * baseline's version). Called after `setup`, so adapters must not trust the path alone.
   */
  installArtifact(workspace: WorkspacePin, artifact: ArtifactBundle): Promise<InstalledArtifact>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class UnsupportedCapabilityError extends Error {
  override name = 'UnsupportedCapabilityError';
}
