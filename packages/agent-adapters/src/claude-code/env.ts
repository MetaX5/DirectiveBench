import { isAbsolute, join } from 'node:path';
import { MIN_KNOWN_SECRET_LENGTH } from '@directivebench/core';
import type { ClaudeAuthMode } from '../claude-code-readiness';
import { ClaudeCodeError } from './errors';

/** Which user-level configuration the agent can see (SPEC-203 §8, FR-118-03). */
export type ClaudeIsolationProfile = 'user-profile' | 'isolated';

/** Variables inherited from the CLI process; everything else is dropped (SPEC-110 FR-110-42). */
export const CLAUDE_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
] as const;

/** Run-local home of API Key Mode: Claude Code's configuration directory lives below it. */
export const ISOLATED_CLAUDE_CONFIG_DIR = '.claude';

interface CommonEnvInput {
  /** The CLI process environment the allowlisted variables are copied from. */
  baseEnv: NodeJS.ProcessEnv;
  /** Run-local temporary directory for `TMPDIR`, `TEMP` and `TMP` (absolute). */
  tempDir: string;
}

export type ClaudeEnvInput =
  | (CommonEnvInput & { authMode: 'subscription' })
  | (CommonEnvInput & {
      authMode: 'api-key';
      /** Run-local home directory (absolute); `CLAUDE_CONFIG_DIR` is its `.claude`. */
      isolatedHome: string;
      /** The resolved key; it reaches the child only as `ANTHROPIC_API_KEY`, never argv. */
      apiKey: string;
    });

function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new Error(`The ${what} must be an absolute path.`);
  return path;
}

/**
 * The complete environment of one `claude` agent process (SPEC-118 FR-118-02/03, SPEC-203 §3, §8).
 * Nothing is inherited beyond {@link CLAUDE_ENV_ALLOWLIST}, so `ANTHROPIC_*`,
 * `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*` never reach the child unless set here.
 *
 * - Local Subscription Mode: the real `HOME` (the declared exception of SPEC-203 §3.2, needed for
 *   the CLI's own login; `USERPROFILE` is kept for the same reason), no `CLAUDE_CONFIG_DIR` (as the
 *   readiness probe, so both see the same login) and no credential variable at all. A missing or relative `HOME` is `auth-missing`.
 * - API Key Mode: `HOME`/`USERPROFILE` are the run-local home, `CLAUDE_CONFIG_DIR` is below it, and
 *   the key is `ANTHROPIC_API_KEY`. A key shorter than `MIN_KNOWN_SECRET_LENGTH` (which redaction
 *   could not remove by value), or one containing a line break or NUL, is `auth-missing`.
 */
export function buildClaudeEnv(input: ClaudeEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CLAUDE_ENV_ALLOWLIST) {
    const value = input.baseEnv[name];
    if (value !== undefined) env[name] = value;
  }
  const tempDir = absolute(input.tempDir, 'temporary directory');
  env.TMPDIR = tempDir;
  env.TEMP = tempDir;
  env.TMP = tempDir;
  if (input.authMode === 'subscription') {
    const home = input.baseEnv.HOME;
    if (home === undefined || !isAbsolute(home)) {
      throw new ClaudeCodeError(
        'auth-missing',
        'Local Subscription Mode needs the real HOME directory, where Claude Code keeps its login.',
      );
    }
    env.HOME = home;
    const profile = input.baseEnv.USERPROFILE;
    if (profile !== undefined) env.USERPROFILE = profile;
    return env;
  }
  // A key shorter than the exact-value redaction minimum could not be removed from the trace.
  if (input.apiKey.trim().length < MIN_KNOWN_SECRET_LENGTH || /[\r\n\0]/.test(input.apiKey)) {
    throw new ClaudeCodeError(
      'auth-missing',
      `API Key Mode needs an ANTHROPIC_API_KEY of at least ${MIN_KNOWN_SECRET_LENGTH} characters on one line.`,
    );
  }
  const home = absolute(input.isolatedHome, 'isolated home directory');
  env.HOME = home;
  env.USERPROFILE = home;
  env.CLAUDE_CONFIG_DIR = join(home, ISOLATED_CLAUDE_CONFIG_DIR);
  env.ANTHROPIC_API_KEY = input.apiKey;
  return env;
}

/**
 * The isolation profile and warnings every run of an auth mode records (FR-118-03): subscription
 * runs see the user's configuration (`user-profile`, warning `ambient-user-config`); API Key Mode
 * runs are `isolated`.
 */
export function claudeAuthProfile(authMode: ClaudeAuthMode): {
  isolationProfile: ClaudeIsolationProfile;
  warnings: string[];
} {
  return authMode === 'subscription'
    ? { isolationProfile: 'user-profile', warnings: ['ambient-user-config'] }
    : { isolationProfile: 'isolated', warnings: [] };
}
