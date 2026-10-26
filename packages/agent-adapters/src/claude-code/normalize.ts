import type { ClaudeAuthMode } from '../claude-code-readiness';
import type { AgentRunMetadata, AgentRunResult, SkillActivation } from '../contract';
import type { ClaudePermissionProfile } from './argv';
import {
  CLAUDE_STREAM_MAX_LINE_BYTES,
  CLAUDE_TRACE_TEXT_MAX_CHARS,
  redactStreamText,
  type ParsedClaudeStream,
} from './stream-parser';

/** SPEC-203 §9 codes an agent run of Claude Code can end with (after the process started). */
export type ClaudeRunErrorCode =
  | 'auth-missing'
  | 'auth-expired'
  | 'auth-invalid'
  | 'auth-mismatch'
  | 'billing'
  | 'rate-limited'
  | 'model-not-found'
  | 'provider-error'
  | 'budget-exceeded'
  | 'agent-failed'
  | 'output-parse-error'
  | 'cli-usage-error';

/** Warning codes of one agent run (SPEC-203 §8/§9, SPEC-118 FR-118-03). */
export type ClaudeRunWarning =
  'ambient-user-config' | 'permission-denied' | 'agent-reported-error' | 'trace-truncated';

/**
 * `apiKeySource` of `system/init` the run must report per auth mode (FR-118-06): `none` is a
 * claude.ai login (also a bearer token or a cloud provider, which the subscription environment
 * removes), `ANTHROPIC_API_KEY` the key DirectiveBench passes. Values from the schema in the local
 * `claude` 2.1.302 binary (SPEC-203 L3); that a real run reports them is for the live check
 * (AC-22). Any other value — or none — fails closed as `auth-mismatch`.
 */
export const CLAUDE_EXPECTED_API_KEY_SOURCE: Readonly<Record<ClaudeAuthMode, string>> = {
  subscription: 'none',
  'api-key': 'ANTHROPIC_API_KEY',
};

/** `error` categories of assistant messages and `api_retry` events → SPEC-203 §9 codes. */
const API_ERROR_CODES: Readonly<Record<string, ClaudeRunErrorCode>> = {
  authentication_failed: 'auth-invalid',
  oauth_org_not_allowed: 'auth-invalid',
  account_on_hold: 'auth-invalid',
  verification_required: 'auth-invalid',
  cloud_credential_error: 'auth-invalid',
  billing_error: 'billing',
  rate_limit: 'rate-limited',
  // A temporary server overload fails this agent run only (maintainer decision 2026-10-22).
  overloaded: 'provider-error',
  model_not_found: 'model-not-found',
};

/** The expired-login texts (SPEC-203 §9); checked before the error categories. */
const EXPIRED_LOGIN: readonly (readonly [RegExp, ClaudeRunErrorCode])[] = [
  [/^(?:Login expired|OAuth token has expired)\b/i, 'auth-expired'],
];

/**
 * The CLI's own failure messages → codes, first match wins. They are matched only against text
 * the CLI wrote (`errors[]`, synthetic messages, non-JSON output, stderr), one line at a time and
 * anchored at its start, so the agent's own words ("added rate limit middleware") never match.
 * The wording is not a contract: a changed message degrades to `provider-error`, `agent-failed`
 * or, for an `is_error` success without a category, to `completed` with `agent-reported-error`.
 */
const TEXT_CODES: readonly (readonly [RegExp, ClaudeRunErrorCode])[] = [
  ...EXPIRED_LOGIN,
  [/^(?:Not logged in|Please run \/login)\b/i, 'auth-missing'],
  [/^Invalid API key\b/i, 'auth-invalid'],
  [/^Credit balance is too low\b/i, 'billing'],
  [
    /^(?:API Error: Rate limit reached|Claude AI usage limit reached|You've hit your (?:\w+ )?limit|[\w-]+ limit reached\W+resets)/i,
    'rate-limited',
  ],
];

/** How the `claude` process ended; timeout and cancellation are decided by the caller. */
export interface ClaudeProcessExit {
  exitCode: number | null;
  /** Redacted by the caller or here; only its tail is kept. */
  stderr?: string;
}

export interface ClaudeRunClassification {
  status: 'completed' | 'agent-error';
  errorCode: ClaudeRunErrorCode | null;
  /** Message for the user, redacted; null when completed. */
  error: string | null;
  warnings: ClaudeRunWarning[];
}

/** Text the CLI wrote about a failure: `errors[]` and synthetic main-conversation messages. */
function failureTexts(parsed: ParsedClaudeStream): string[] {
  return [...(parsed.result?.errors ?? []), ...parsed.syntheticTexts];
}

function textCode(
  texts: readonly string[],
  patterns: readonly (readonly [RegExp, ClaudeRunErrorCode])[] = TEXT_CODES,
): ClaudeRunErrorCode | null {
  const lines = texts
    .flatMap((text) => text.split('\n'))
    .map((line) => line.replace(/^…/, '').trim());
  for (const [pattern, code] of patterns) {
    if (lines.some((line) => pattern.test(line))) return code;
  }
  return null;
}

function failed(parsed: ParsedClaudeStream, exitCode: number | null): boolean {
  const result = parsed.result;
  return result === null || result.isError || result.subtype !== 'success' || exitCode !== 0;
}

/** The redacted end of `text`; the whole text is redacted before the cut. */
function tail(text: string, secrets: readonly string[]): string {
  return redactStreamText(text, secrets).slice(-CLAUDE_TRACE_TEXT_MAX_CHARS).trim();
}

/**
 * Normalises one finished agent run to an execution status and a SPEC-203 §9 code. Precedence:
 * a credential source other than the chosen mode (`auth-mismatch`) → an authentication, quota or
 * model failure (from the reported text, the assistant `error` category or the last retry) → an
 * unparsable stream → the result subtype → a non-zero exit. A run that exits 0 with `success`
 * completes, with warning `agent-reported-error` when `is_error` is set (SPEC-203 §9). Tool
 * denials are warnings, never errors.
 */
export function classifyClaudeRun(
  parsed: ParsedClaudeStream,
  exit: ClaudeProcessExit,
  authMode: ClaudeAuthMode,
  knownSecrets: readonly string[] = [],
): ClaudeRunClassification {
  const warnings: ClaudeRunWarning[] = [];
  if (authMode === 'subscription') warnings.push('ambient-user-config');
  if (parsed.permissionDenials > 0) warnings.push('permission-denied');
  if (parsed.droppedTraceEvents > 0 || parsed.oversizedLines > 0) warnings.push('trace-truncated');
  const agentError = (errorCode: ClaudeRunErrorCode, error: string): ClaudeRunClassification => ({
    status: 'agent-error',
    errorCode,
    error,
    warnings,
  });

  const source = parsed.init?.apiKeySource ?? null;
  const expected = CLAUDE_EXPECTED_API_KEY_SOURCE[authMode];
  if (parsed.init && source !== expected) {
    return agentError(
      'auth-mismatch',
      `Claude Code used the credential source "${source ?? 'not reported'}", not the one of ${authMode} mode ("${expected}").`,
    );
  }

  const result = parsed.result;
  if (result?.subtype === 'error_max_budget_usd') {
    return agentError(
      'budget-exceeded',
      'Claude Code stopped at the budget cap (--max-budget-usd).',
    );
  }
  if (failed(parsed, exit.exitCode)) {
    const texts = failureTexts(parsed);
    // A retry counts only when the run ended without a regular error subtype; the parser already
    // dropped one the model recovered from.
    const retried =
      result === null || result.subtype === 'success' ? parsed.lastRetryCategory : null;
    const category = parsed.apiError ?? retried;
    const code =
      textCode(texts, EXPIRED_LOGIN) ??
      (category !== null ? (API_ERROR_CODES[category] ?? 'provider-error') : textCode(texts)) ??
      // A message the CLI wrote itself about a failure it did not categorise.
      (parsed.syntheticTexts.length > 0 ? 'provider-error' : null);
    if (code !== null) {
      return agentError(code, `Claude Code failed (${code}): ${texts[0] ?? category}`);
    }
  }

  // A dropped over-long line may have held a model, a skill call or an error: fail closed.
  if (
    result === null ||
    parsed.eventsOverflow ||
    parsed.malformedLines > 0 ||
    parsed.oversizedLines > 0
  ) {
    const stderr = tail(exit.stderr ?? '', knownSecrets);
    // A login or quota message printed outside the stream still stops the run (FR-118-15).
    const outside = textCode([parsed.rawTail ?? '', stderr]);
    if (outside !== null) {
      return agentError(
        outside,
        `Claude Code failed (${outside}): ${parsed.rawTail ?? ''}${parsed.rawTail && stderr ? ' / ' : ''}${stderr}`,
      );
    }
    if (parsed.events === 0 && exit.exitCode !== 0) {
      return agentError(
        'cli-usage-error',
        `Claude Code exited with code ${exit.exitCode ?? 'none'} before any output${stderr ? `: ${stderr}` : '.'}`,
      );
    }
    const reason = parsed.eventsOverflow
      ? 'the stream has too many events'
      : parsed.malformedLines > 0
        ? `${parsed.malformedLines} line(s) are not valid stream events`
        : parsed.oversizedLines > 0
          ? `${parsed.oversizedLines} line(s) are longer than ${CLAUDE_STREAM_MAX_LINE_BYTES} bytes and were dropped`
          : parsed.events === 0
            ? 'Claude Code wrote no output'
            : 'the stream has no result line';
    return agentError(
      'output-parse-error',
      `Claude Code output could not be read: ${reason}.${parsed.rawTail ? ` Last line: ${parsed.rawTail}` : ''}`,
    );
  }

  // Without the session start nothing says which credentials or model ran, or whether the
  // skill loaded: such a run never counts as completed (failures above keep their codes).
  if (parsed.init === null) {
    return agentError(
      'output-parse-error',
      'Claude Code output could not be read: the stream has no session start (system/init).',
    );
  }
  if (result.subtype !== 'success') {
    return agentError(
      'agent-failed',
      `Claude Code ended with ${result.subtype}${result.errors.length ? `: ${result.errors.join('; ')}` : '.'}`,
    );
  }
  if (exit.exitCode !== 0) {
    return agentError('agent-failed', `Claude Code exited with code ${exit.exitCode ?? 'none'}.`);
  }
  if (result.isError) warnings.push('agent-reported-error');
  return { status: 'completed', errorCode: null, error: null, warnings };
}

/** `skillActivation` of a `skill-md` run (FR-118-09); absent before `system/init` was seen. */
export function claudeSkillActivation(parsed: ParsedClaudeStream): SkillActivation | undefined {
  const init = parsed.init;
  if (!init) return undefined;
  const slash = parsed.slashExpanded ? 'observed' : parsed.slashInferred ? 'inferred' : null;
  const loaded = init.skillTool && (!init.skillsListed || init.skillListed);
  // An inferred `/<name>` expansion needs the skill loaded: an unlisted skill was not expanded.
  const counted = slash === 'observed' || (slash === 'inferred' && loaded);
  const invocations = parsed.skillInvocations + (counted ? 1 : 0);
  return {
    loaded,
    invoked: invocations > 0,
    invocations,
    otherSkills: parsed.otherSkills,
    ...(counted ? { slashInvocation: slash } : {}),
  };
}

/** Run conditions the adapter knows before the stream (SPEC-203 §4.2). */
export interface ClaudeRunConditions {
  adapterVersion: string | null;
  authMode: ClaudeAuthMode;
  permissionProfile: ClaudePermissionProfile;
  requestedModel: string | null;
  flagsHash: string;
  /** `skill-md` runs only: whether to report `skillActivation`. */
  skill: boolean;
}

/** Placeholder model for a model set that exceeded its bound, so the run cannot compare equal. */
export const TOO_MANY_MODELS = '<too many models>';

/**
 * The agent-run metadata of FR-118-04: the execution model from `system/init`, every reported
 * model, the auxiliary ones (reported, but on no main-conversation message) and the
 * main-conversation models other than the execution model (a mismatch). A model set that
 * overflowed its bound fails closed as a mismatch.
 */
export function claudeRunMetadata(
  parsed: ParsedClaudeStream,
  conditions: ClaudeRunConditions,
): AgentRunMetadata {
  const init = parsed.init;
  const executionModel = init?.model ?? null;
  const main = new Set(parsed.messageModels);
  const mismatched = new Set(init ? [...parsed.messageModels, ...init.laterModels] : []);
  if (init) mismatched.delete(init.model);
  if (parsed.modelsOverflow) mismatched.add(TOO_MANY_MODELS);
  return {
    adapterVersion: conditions.adapterVersion,
    authMode: conditions.authMode,
    isolationProfile: conditions.authMode === 'api-key' ? 'isolated' : 'user-profile',
    permissionProfile: conditions.permissionProfile,
    requestedModel: conditions.requestedModel,
    executionModel,
    reportedModels: parsed.reportedModels,
    auxiliaryModels: parsed.reportedModels.filter(
      (model) => !main.has(model) && model !== executionModel,
    ),
    mismatchedMessageModels: [...mismatched].sort(),
    flagsHash: conditions.flagsHash,
  };
}

/**
 * Everything of an `AgentRunResult` the stream and exit decide (the caller adds `durationMs`, and
 * decides timeout and cancellation itself). In Local Subscription Mode the cost is dropped: the
 * CLI's estimate means nothing against a plan ("n/a (subscription)", SPEC-203 §4).
 */
export function claudeRunOutcome(
  parsed: ParsedClaudeStream,
  exit: ClaudeProcessExit,
  conditions: ClaudeRunConditions,
  knownSecrets: readonly string[] = [],
): Omit<AgentRunResult, 'durationMs'> {
  const classification = classifyClaudeRun(parsed, exit, conditions.authMode, knownSecrets);
  const usage = parsed.usage ? { ...parsed.usage } : null;
  if (usage && conditions.authMode === 'subscription') delete usage.costUsd;
  const skillActivation = conditions.skill ? claudeSkillActivation(parsed) : undefined;
  const trace = [...parsed.trace];
  if (parsed.droppedTraceEvents > 0) {
    trace.push({
      type: 'message',
      text: `${parsed.droppedTraceEvents} further trace event(s) were not kept.`,
    });
  }
  return {
    status: classification.status,
    summary:
      classification.error ??
      `Claude Code finished${parsed.result?.numTurns != null ? ` after ${parsed.result.numTurns} turn(s)` : ''}.`,
    trace,
    usage: usage && Object.keys(usage).length > 0 ? usage : null,
    error: classification.error,
    ...(classification.errorCode === null ? {} : { errorCode: classification.errorCode }),
    warnings: classification.warnings,
    metadata: claudeRunMetadata(parsed, conditions),
    ...(skillActivation ? { skillActivation } : {}),
    // Every format: an instruction run can use a skill too (e.g. a `/<skill>` prompt).
    otherSkillsInvoked: parsed.otherSkillsInvoked,
  };
}
