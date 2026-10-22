/**
 * Why the Claude Code adapter refuses a configuration or an artifact before any `claude` process
 * starts. The codes are part of the user-visible contract (SPEC-203 §9, SPEC-118 §13).
 */
export type ClaudeCodeErrorCode =
  /** API Key Mode without a usable key, or Local Subscription Mode without a home directory. */
  | 'auth-missing'
  /** `execution.model` names a provider other than `anthropic` (SPEC-203 §7). */
  | 'model-provider-unsupported'
  /** The model name could be read as a flag or contains characters a model name never has. */
  | 'model-invalid'
  /** `--max-budget-usd` outside API Key Mode (SPEC-118 FR-118-30). */
  | 'budget-requires-api-key'
  /** A budget that is not a positive, finite number. */
  | 'budget-invalid'
  /** A skill name an allow rule cannot carry safely (FR-118-08). */
  | 'skill-name-unsupported'
  /** The artifact format has no Claude Code install convention (SPEC-203 §4.1, FR-118-25). */
  | 'artifact-format-unsupported'
  /** The install target already exists or is not a plain path in the workspace (SPEC-203 §4.1). */
  | 'artifact-install-conflict'
  /** The workspace path no longer is the directory pinned at creation (SPEC-118 §12). */
  | 'workspace-replaced';

export class ClaudeCodeError extends Error {
  override name = 'ClaudeCodeError';

  constructor(
    readonly code: ClaudeCodeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
