import type { AgentModeReadiness } from './contract';
import { findExecutable, readVersionLine, runProbe } from './probe';

/**
 * Claude Code readiness (SPEC-118 FR-118-02/35, SPEC-203 §3, §7, §9): can `claude` run a
 * benchmark in a given auth mode? It never reads credential files, never prints or stores the
 * API key (only whether it is non-empty) and keeps nothing of the `auth status` output except
 * `loggedIn` and `authMethod`.
 */

export const CLAUDE_EXECUTABLE = 'claude';

/** SPEC-203 §7 `minimumVersion` (needed for `--permission-prompts`). */
export const CLAUDE_CODE_MIN_VERSION = '2.1.259';

/** Upper bound on `claude auth status`; it answers locally (observed well under 1 s). */
export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;

/** Output kept from `claude auth status`; the JSON object is a few hundred bytes. */
export const CLAUDE_AUTH_STATUS_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Arguments of the subscription login probe. `--setting-sources project,local` (a top-level
 * option: `auth status` itself rejects it) matches the subscription run (SPEC-203 §6, §8), so a
 * user-level `apiKeyHelper` — which the run never loads — cannot make the probe report a login
 * (observed on 2.1.302: with it `authMethod` is `api_key_helper`, without it `none`). `--json` is
 * the default today; passing it keeps the parser independent of that default.
 */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = [
  '--setting-sources',
  'project,local',
  'auth',
  'status',
  '--json',
];

/**
 * `authMethod` values of a Claude subscription login (SPEC-203 §3.2, evidence L2: `claude.ai`).
 * Any other or missing method — `api_key`, `api_key_helper`, a cloud provider — is not the
 * subscription the run would use, so it fails closed.
 */
export const CLAUDE_SUBSCRIPTION_AUTH_METHODS: readonly string[] = ['claude.ai'];

/** The only API-key source in S1 (FR-118-02, Q6): the CLI process environment. */
export const CLAUDE_API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

export type ClaudeAuthMode = 'subscription' | 'api-key';

export const CLAUDE_AUTH_MODES: readonly ClaudeAuthMode[] = ['subscription', 'api-key'];

/** SPEC-203 §9 codes a readiness check can end with. */
export type ClaudeReadinessCode =
  'binary-not-found' | 'version-unsupported' | 'auth-missing' | 'auth-expired' | 'auth-mismatch';

export interface ClaudeCodeReadiness extends AgentModeReadiness {
  mode: ClaudeAuthMode;
  code: ClaudeReadinessCode | null;
}

export interface ClaudeCodeReadinessReport extends ClaudeCodeReadiness {
  executablePath: string | null;
  /** Parsed `major.minor.patch`, or null when `claude` is missing or the version is unreadable. */
  version: string | null;
}

/** What detection already knows about the binary: its absolute path and first version line. */
export interface ClaudeCodeTarget {
  executablePath: string | null;
  versionLine: string | null;
}

/** Extracts `major.minor.patch` from `claude --version` output such as `2.1.296 (Claude Code)`. */
export function parseClaudeCodeVersion(versionLine: string | null): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionLine ?? '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** True when `version` (as parsed by `parseClaudeCodeVersion`) is at least the minimum. */
export function isSupportedClaudeCodeVersion(
  version: string,
  minimum: string = CLAUDE_CODE_MIN_VERSION,
): boolean {
  // Numeric collation compares each digit run as a number, so `2.10.0` > `2.9.0`.
  return version.localeCompare(minimum, 'en', { numeric: true }) >= 0;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** Login method as reported (e.g. `claude.ai`), only if it is a short plain token. */
  authMethod: string | null;
}

const AUTH_METHOD_PATTERN = /^[\w.-]{1,40}$/;

/**
 * Parses the JSON printed by `claude auth status`, keeping only `loggedIn` and `authMethod`.
 * Everything else in it (email, organisation, directories) is personal and is dropped here.
 * Returns null when the output is not an object with a boolean `loggedIn`.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { loggedIn, authMethod } = value as Record<string, unknown>;
  if (typeof loggedIn !== 'boolean') return null;
  return {
    loggedIn,
    authMethod:
      typeof authMethod === 'string' && AUTH_METHOD_PATTERN.test(authMethod) ? authMethod : null,
  };
}

/** SPEC-203 §9: an expired login reads like `Login expired · Please run /login`. */
const EXPIRED_LOGIN_PATTERN = /login expired/i;

const LOGIN_HINT = 'run `claude` and `/login`, or use API key mode';

function result(
  mode: ClaudeAuthMode,
  code: ClaudeReadinessCode | null,
  detail: string,
): ClaudeCodeReadiness {
  return { mode, ready: code === null, code, detail };
}

async function subscriptionReadiness(
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodeReadiness> {
  const probe = await runProbe(executablePath, CLAUDE_AUTH_STATUS_ARGS, {
    env,
    timeoutMs: CLAUDE_AUTH_STATUS_TIMEOUT_MS,
    maxOutputBytes: CLAUDE_AUTH_STATUS_MAX_OUTPUT_BYTES,
  });
  if (probe.failure) {
    const reason = {
      timeout: `did not answer within ${CLAUDE_AUTH_STATUS_TIMEOUT_MS / 1000} s`,
      'output-limit': `printed more than ${CLAUDE_AUTH_STATUS_MAX_OUTPUT_BYTES} bytes`,
      failed: 'could not be run',
    }[probe.failure];
    return result(
      'subscription',
      'auth-missing',
      `Login not confirmed: \`claude auth status\` ${reason}.`,
    );
  }
  const status = parseClaudeAuthStatus(probe.stdout);
  if (status?.loggedIn && probe.exitCode === 0) {
    if (
      status.authMethod !== null &&
      CLAUDE_SUBSCRIPTION_AUTH_METHODS.includes(status.authMethod)
    ) {
      return result('subscription', null, `Logged in (${status.authMethod}).`);
    }
    return result(
      'subscription',
      'auth-mismatch',
      `Logged in with ${status.authMethod ?? 'an unreported method'}, not a Claude subscription: run \`claude\` and \`/login\` with a subscription account, or use API key mode.`,
    );
  }
  if (status?.loggedIn === false) {
    return result('subscription', 'auth-missing', `Not logged in: ${LOGIN_HINT}.`);
  }
  // Only output that is not a status object is searched for the expiry text, so no field of a
  // parsed status (email, organisation) can trigger it.
  if (!status && EXPIRED_LOGIN_PATTERN.test(probe.stdout)) {
    return result('subscription', 'auth-expired', `The login has expired: ${LOGIN_HINT}.`);
  }
  return result(
    'subscription',
    'auth-missing',
    `Login not confirmed: \`claude auth status\` gave no readable status (exit ${probe.exitCode}).`,
  );
}

function apiKeyReadiness(env: NodeJS.ProcessEnv): ClaudeCodeReadiness {
  const present = (env[CLAUDE_API_KEY_VARIABLE] ?? '').trim() !== '';
  return present
    ? result('api-key', null, `${CLAUDE_API_KEY_VARIABLE} is set.`)
    : result(
        'api-key',
        'auth-missing',
        `${CLAUDE_API_KEY_VARIABLE} is not set (or empty) in this process's environment.`,
      );
}

/** Readiness of one auth mode for a binary detection already located. */
export async function claudeCodeModeReadiness(
  mode: ClaudeAuthMode,
  target: ClaudeCodeTarget,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodeReadiness> {
  if (!target.executablePath) {
    return result(mode, 'binary-not-found', `\`${CLAUDE_EXECUTABLE}\` was not found on PATH.`);
  }
  const version = parseClaudeCodeVersion(target.versionLine);
  if (!version) {
    return result(
      mode,
      'version-unsupported',
      `Could not read the Claude Code version from \`${CLAUDE_EXECUTABLE} --version\`.`,
    );
  }
  if (!isSupportedClaudeCodeVersion(version)) {
    return result(
      mode,
      'version-unsupported',
      `Claude Code ${version} is older than the minimum ${CLAUDE_CODE_MIN_VERSION}; update it.`,
    );
  }
  return mode === 'api-key'
    ? apiKeyReadiness(env)
    : subscriptionReadiness(target.executablePath, env);
}

/** Readiness of every supported auth mode, for detection (Agent Connections, `doctor`). */
export function claudeCodeReadiness(
  target: ClaudeCodeTarget,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodeReadiness[]> {
  return Promise.all(CLAUDE_AUTH_MODES.map((mode) => claudeCodeModeReadiness(mode, target, env)));
}

/**
 * The readiness check a run performs before it creates a job (FR-118-35): locate `claude` on
 * `PATH`, check its version, then check the chosen auth mode.
 */
export async function checkClaudeCodeReadiness(
  mode: ClaudeAuthMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeReadinessReport> {
  const executablePath = await findExecutable(CLAUDE_EXECUTABLE, env);
  const versionLine = executablePath
    ? await readVersionLine(executablePath, ['--version'], env)
    : null;
  const readiness = await claudeCodeModeReadiness(mode, { executablePath, versionLine }, env);
  return { ...readiness, executablePath, version: parseClaudeCodeVersion(versionLine) };
}
