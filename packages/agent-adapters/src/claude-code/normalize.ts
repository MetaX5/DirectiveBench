import { redactSecrets } from '@directivebench/core';
import type { ClaudeAuthMode } from '../claude-code-readiness';
import type { AgentRunMetadata, AgentRunResult, SkillActivation } from '../contract';
import type { ClaudePermissionProfile } from './argv';
import { CLAUDE_TRACE_TEXT_MAX_CHARS, type ParsedClaudeStream } from './stream-parser';

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
  overloaded: 'rate-limited',
  model_not_found: 'model-not-found',
};

/** The expired-login text SPEC-203 §9 names; checked before the error categories. */
const EXPIRED_LOGIN = /login expired|token (?:has )?expired/i;

/**
 * Other failure texts (result text, `errors[]`, CLI-written messages) → codes, first match wins.
 * They are the CLI's usual wording and are checked after the categories, so a changed wording
 * degrades to `provider-error` or `agent-failed`, never to success.
 */
const TEXT_CODES: readonly (readonly [RegExp, ClaudeRunErrorCode])[] = [
  [/not logged in|please run \/login/i, 'auth-missing'],
  [/invalid api key|authentication[ _]failed/i, 'auth-invalid'],
  [/credit balance is too low|billing[ _]error/i, 'billing'],
  [/usage limit|rate[ _]limit|limit reached\W+resets/i, 'rate-limited'],
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

function failureTexts(parsed: ParsedClaudeStream): string[] {
  const result = parsed.result;
  return [
    ...(result?.isError && result.text !== null ? [result.text] : []),
    ...(result?.errors ?? []),
    ...parsed.syntheticTexts,
  ];
}

function textCode(texts: readonly string[]): ClaudeRunErrorCode | null {
  for (const [pattern, code] of TEXT_CODES) {
    if (texts.some((text) => pattern.test(text))) return code;
  }
  return null;
}

function failed(parsed: ParsedClaudeStream, exitCode: number | null): boolean {
  const result = parsed.result;
  return result === null || result.isError || result.subtype !== 'success' || exitCode !== 0;
}

function tail(text: string, secrets: readonly string[]): string {
  return redactSecrets(text.slice(-CLAUDE_TRACE_TEXT_MAX_CHARS), secrets).trim();
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
    // A retry that recovered says nothing about a later failure: it counts only when the run
    // ended without a regular error subtype.
    const retried =
      result === null || result.subtype === 'success' ? parsed.lastRetryCategory : null;
    const category = parsed.apiErrors.at(-1) ?? retried;
    const code = texts.some((text) => EXPIRED_LOGIN.test(text))
      ? 'auth-expired'
      : category !== null
        ? (API_ERROR_CODES[category] ?? 'provider-error')
        : textCode(texts);
    if (code !== null) {
      return agentError(code, `Claude Code failed (${code}): ${texts[0] ?? category}`);
    }
  }

  if (result === null || parsed.eventsOverflow || parsed.malformedLines > 0) {
    if (parsed.events === 0 && exit.exitCode !== 0) {
      const stderr = tail(exit.stderr ?? '', knownSecrets);
      return agentError(
        'cli-usage-error',
        `Claude Code exited with code ${exit.exitCode ?? 'none'} before any output${stderr ? `: ${stderr}` : '.'}`,
      );
    }
    const reason = parsed.eventsOverflow
      ? 'the stream has too many events'
      : parsed.malformedLines > 0
        ? `${parsed.malformedLines} line(s) are not valid stream events`
        : parsed.events === 0
          ? 'Claude Code wrote no output'
          : 'the stream has no result line';
    return agentError(
      'output-parse-error',
      `Claude Code output could not be read: ${reason}.${parsed.rawTail ? ` Last line: ${parsed.rawTail}` : ''}`,
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
  const invocations = parsed.skillInvocations + (parsed.slashExpanded ? 1 : 0);
  return {
    loaded: init.skillTool && (!init.skillsListed || init.skillListed),
    invoked: invocations > 0,
    invocations,
    otherSkills: parsed.otherSkills,
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
  };
}
