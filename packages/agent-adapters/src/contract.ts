import type { ArtifactBundle, ModelSelection } from '@directivebench/core';

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

export interface AgentDetection {
  adapterId: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  /** Authentication state when it can be determined without reading credential files. */
  auth: AuthReadiness;
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
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  model: ModelSelection | null;
  /** Adapter-specific options from the benchmark case (`agentOptions[adapterId]`). */
  options: unknown;
}

export type AgentExecutionStatus = 'completed' | 'agent-error' | 'timeout' | 'cancelled';

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
  /** Installs one exact artifact version into a workspace (GREEN/candidate variant only). */
  installArtifact(workspaceDir: string, artifact: ArtifactBundle): Promise<InstalledArtifact>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class UnsupportedCapabilityError extends Error {
  override name = 'UnsupportedCapabilityError';
}
