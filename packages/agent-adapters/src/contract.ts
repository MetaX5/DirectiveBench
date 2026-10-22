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
  | { type: 'error'; message: string }
  /** A tool call of a real agent (SPEC-203 §4.2); `input` is truncated, redacted JSON. */
  | { type: 'tool-call'; tool: string; callId: string; input?: string }
  /** The result of a tool call; `output` is truncated and redacted. */
  | { type: 'tool-result'; callId: string; ok: boolean; output?: string }
  /** A tool use the permission rules denied; part of the measured behaviour, not an error. */
  | { type: 'permission-denied'; tool: string; callId?: string }
  /** The agent retried an API request (`category` as reported, e.g. `rate_limit`). */
  | { type: 'retry'; attempt: number; category: string; httpStatus?: number };

export interface AgentRunRequest {
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  model: ModelSelection | null;
  /** Adapter-specific options from the benchmark case (`agentOptions[adapterId]`). */
  options: unknown;
}

export type AgentExecutionStatus =
  'completed' | 'agent-error' | 'timeout' | 'cancelled' | 'infrastructure-error';

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens read from the prompt cache. */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationInputTokens?: number;
  /** As reported by the harness; for Claude Code a client-side estimate (SPEC-203 §4). */
  costUsd?: number;
}

/**
 * The conditions one agent run of a real harness ran under (SPEC-203 §4.2, SPEC-118 FR-118-04).
 * The engine requires every field except the model lists to be equal for all agent runs of a
 * benchmark run, and the execution model to be the only main-conversation model.
 */
export interface AgentRunMetadata {
  adapterVersion: string | null;
  authMode: 'subscription' | 'api-key';
  isolationProfile: 'isolated' | 'user-profile';
  permissionProfile: 'edit-only' | 'edit-and-shell';
  /** `execution.model` as requested; null = the harness default. */
  requestedModel: string | null;
  /** The session model the harness resolved; null when the run ended before reporting it. */
  executionModel: string | null;
  /** Every model the harness reported usage for, sorted. */
  reportedModels: string[];
  /** Reported models no main-conversation message used (internal harness work), sorted. */
  auxiliaryModels: string[];
  /** Main-conversation message models other than `executionModel`, sorted; non-empty = mismatch. */
  mismatchedMessageModels: string[];
  /** sha256 of the normalised argv (FR-118-04). */
  flagsHash: string;
}

/** Whether the installed skill was loaded and used in one agent run (SPEC-118 FR-118-09). */
export interface SkillActivation {
  loaded: boolean;
  invoked: boolean;
  /** Successful invocations of the installed skill, + 1 for an expanded `/<name>` prompt. */
  invocations: number;
  /** Other skill names the agent attempted, sorted (all denied by the profile). */
  otherSkills: string[];
}

export interface AgentRunResult {
  status: AgentExecutionStatus;
  durationMs: number;
  summary: string;
  trace: TraceEvent[];
  usage: AgentUsage | null;
  error: string | null;
  /** Machine-readable failure code (SPEC-203 §9), when the adapter has one. */
  errorCode?: string;
  /** Warning codes of this agent run (e.g. `ambient-user-config`, `permission-denied`). */
  warnings?: string[];
  /** Reported by real-harness adapters; absent for the mock agent. */
  metadata?: AgentRunMetadata;
  /** For `skill-md` artifacts, when the harness reported its session start. */
  skillActivation?: SkillActivation;
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
