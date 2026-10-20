import {
  CREDENTIALS_IN_URL_MESSAGE,
  looksLikeRepositoryUrl,
  parseRepositoryUrl,
  repositoryPathInputSchema,
  type RepositoryUrlErrorCode,
} from '@directivebench/core';
import {
  SCANNABLE_PROVIDERS,
  type RepositoryRecord,
  type RepositoryRegistration,
  type RepositoryRegistrationResult,
  type RepositoryScan,
} from '@directivebench/database';
import { formatDate, formatDuration } from './utils';

export type RepositoryProvider = RepositoryRecord['provider'];

const PROVIDER_LABELS: Record<RepositoryProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  'local-git': 'Local Git',
  'local-directory': 'Local directory',
  'bundled-examples': 'Bundled examples',
};

export function providerLabel(provider: RepositoryProvider): string {
  return PROVIDER_LABELS[provider];
}

/** Providers that track a branch (SPEC-104 FR-104-07); directories and examples have none. */
const BRANCHED_PROVIDERS: ReadonlySet<RepositoryProvider> = new Set([
  'github',
  'gitlab',
  'local-git',
]);

/**
 * The branch shown in the repository list (FR-104-16): the selected branch, else the detected
 * default. Null when the provider has no branches; "not detected" for a detached HEAD.
 */
export function branchLabel(
  repository: Pick<RepositoryRecord, 'provider' | 'selectedBranch' | 'defaultBranch'>,
): string | null {
  if (!BRANCHED_PROVIDERS.has(repository.provider)) return null;
  return repository.selectedBranch ?? repository.defaultBranch ?? 'not detected';
}

/**
 * The field error for a path or URL the action sent back (`?path=`), or null when it is valid.
 * It is computed again from the input, so no free text from the page URL is rendered as an error.
 */
export function pathFieldError(input: string): string | null {
  if (looksLikeRepositoryUrl(input)) {
    const url = parseRepositoryUrl(input);
    return url.ok ? null : url.message;
  }
  const parsed = repositoryPathInputSchema.safeParse(input);
  return parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join(' ');
}

/**
 * Whether rejected registration input may carry credentials, so it must never be echoed into a
 * redirect URL or pre-filled into the field again (SPEC-104 FR-104-05). Every way to put a
 * secret into a URL needs one of these characters — user info (`@`), a query (`?`), a fragment
 * (`#`) — or its percent-encoding, whether or not the input is a well-formed URL
 * (`https:/github.com/a/b?access_token=…`, `http//user:token@github.com/…`). A `%25` (double
 * encoding) and the fullwidth lookalikes `＠`, `？`, `＃` count too. The rule depends on the
 * characters only, not on how the action classified the input, so no branch can leak.
 */
export function mayCarryCredentials(input: string): boolean {
  return /[@?#\uFF20\uFF1F\uFF03]|%(?:40|3f|23|25)/i.test(input);
}

/**
 * Whether the input starts like a protocol-relative URL (`//host/…`, `\\host\…`). Such input
 * is a valid absolute path, so it would otherwise be registered — and stored — as typed.
 */
export function looksLikeProtocolRelativeUrl(input: string): boolean {
  return /^[\\/]{2}/.test(input.trim());
}

/**
 * Why the action sent the input back without it (`?urlError=`): a URL rejection reason, or
 * `not-echoed` for input that is neither a valid path nor recognised as a URL but may hold
 * credentials.
 */
export type RejectedInputCode = RepositoryUrlErrorCode | 'not-echoed';

/** Fixed messages for input the action sent back without the input (`?urlError=`). */
const URL_ERRORS: Record<RejectedInputCode, string> = {
  'credentials-in-url': CREDENTIALS_IN_URL_MESSAGE,
  'unsupported-provider':
    'Only public GitHub repositories can be registered by URL so far. Enter https://github.com/<owner>/<repo>.',
  'invalid-url': 'Enter a GitHub repository URL such as https://github.com/<owner>/<repo>.',
  'not-echoed':
    'This is not a valid local path or GitHub URL. It is not shown again because it contains @, ? or # (or an encoded form of them), which can carry credentials. Enter an absolute path such as /home/you/project or ~/project, or https://github.com/<owner>/<repo>.',
};

/** The field error for `?urlError=`, or null for no or an unknown value. */
export function urlFieldError(code: string | undefined): string | null {
  return code !== undefined && Object.hasOwn(URL_ERRORS, code)
    ? URL_ERRORS[code as RejectedInputCode]
    : null;
}

/**
 * What the Repositories page says about a registration job. `active` keeps the page refreshing;
 * `fieldError` is shown under the path field (the path is pre-filled again).
 */
export type RegistrationNotice =
  | { kind: 'active'; path: string; message: string }
  | { kind: 'done'; path: string; message: string }
  | { kind: 'fieldError'; path: string; message: string }
  | {
      kind: 'confirm';
      path: string;
      /** The canonical location the runner asks the user to confirm (sent back on confirm). */
      location: string;
      message: string;
      /** One sentence per reason, each saying what registering would cause. */
      reasons: string[];
    };

type ConfirmationRequest = Extract<RepositoryRegistrationResult, { code: 'confirmation-required' }>;

/**
 * The FR-104-18 explanation: why this location needs a confirmation — the size of a scan and the
 * same files counted as occurrences of two repositories. User-level agent folders are never part
 * of it: a scan always skips them (product decision D05).
 */
export function confirmationReasons(request: ConfirmationRequest): string[] {
  const reasons: string[] = [];
  const userLevel =
    'User-level agent folders such as ~/.claude, ~/.codex, ~/.cursor and ~/.agents are always skipped.';
  if (request.home === 'home') {
    reasons.push(
      `This is your home directory. A scan reads every file below it (except .git and node_modules), which can take long, and includes the skills of every project in it. ${userLevel}`,
    );
  } else if (request.home === 'contains-home') {
    reasons.push(
      `This directory contains your home directory. A scan reads every file below it (except .git and node_modules), which can take very long. ${userLevel}`,
    );
  }
  for (const overlap of request.overlaps) {
    const subject = `${overlap.name} (${overlap.location})`;
    reasons.push(
      overlap.relation === 'inside'
        ? `It is inside the registered repository ${subject}. Its files are already scanned there; registering it too counts each of its artifacts twice, once per repository.`
        : `It contains the registered repository ${subject}. A scan reads that repository's files again and counts each of its artifacts twice, once per repository.`,
    );
  }
  return reasons;
}

export function describeRegistration(registration: RepositoryRegistration): RegistrationNotice {
  const { input: path, status, result } = registration;
  switch (status) {
    case 'pending':
      return {
        kind: 'active',
        path,
        message: `Waiting for the runner to check ${path}. It runs inside directivebench serve.`,
      };
    case 'running':
      return {
        kind: 'active',
        path,
        message:
          registration.source === 'url'
            ? `Asking GitHub about ${path} (read-only, without credentials; nothing is downloaded yet)…`
            : `Checking ${path} (read-only)…`,
      };
    case 'failed':
      return {
        kind: 'fieldError',
        path,
        message: `The check failed: ${registration.error ?? 'unknown error'}`,
      };
    case 'cancelled':
      return { kind: 'fieldError', path, message: 'The registration was cancelled.' };
    case 'interrupted':
      return {
        kind: 'fieldError',
        path,
        message: 'The runner stopped before the check finished. Register it again.',
      };
    case 'completed':
      break;
  }
  if (!result) {
    return { kind: 'fieldError', path, message: 'The runner finished without a result.' };
  }
  if (!result.ok && result.code === 'confirmation-required') {
    return {
      kind: 'confirm',
      path,
      location: result.location,
      message: `Register ${result.location} anyway?`,
      reasons: confirmationReasons(result),
    };
  }
  if (!result.ok) return { kind: 'fieldError', path, message: result.message };
  const repository = registration.repository;
  if (!repository) {
    return { kind: 'fieldError', path, message: 'The registered repository no longer exists.' };
  }
  const subject = `${repository.name} (${providerLabel(repository.provider)}, ${repository.location})`;
  return {
    kind: 'done',
    path,
    message: result.created ? `Registered ${subject}.` : `${subject} is already registered.`,
  };
}

/** Whether the Repositories page offers "Scan" for a repository (local and GitHub so far). */
export function canScan(repository: Pick<RepositoryRecord, 'provider'>): boolean {
  return (SCANNABLE_PROVIDERS as readonly string[]).includes(repository.provider);
}

/** The "Last scan" cell (FR-104-16): when it last succeeded, or that it failed. */
export function lastScanLabel(
  repository: Pick<RepositoryRecord, 'syncStatus' | 'lastSyncAt' | 'syncError'>,
): string {
  if (repository.syncStatus === 'error')
    return `Failed: ${repository.syncError ?? 'unknown error'}`;
  return repository.lastSyncAt ? formatDate(repository.lastSyncAt) : 'Never';
}

/** What the Repositories page says about a scan job; `active` keeps the page refreshing. */
export interface ScanNotice {
  kind: 'active' | 'done' | 'error';
  message: string;
  /** Discovery errors to list (path, code, message); empty unless the scan completed. */
  errors: { path: string; code: string; message: string }[];
  /** How many errors the scan found in total (the list is capped). */
  errorCount: number;
  /** One informational line, e.g. the user-level folders the scan skipped; not an error. */
  info: string | null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function describeScan(scan: RepositoryScan): ScanNotice {
  const name = scan.repository?.name ?? 'the repository';
  const notice = (kind: ScanNotice['kind'], message: string): ScanNotice => ({
    kind,
    message,
    errors: [],
    errorCount: 0,
    info: null,
  });
  switch (scan.status) {
    case 'pending':
      return notice('active', `Waiting for the runner to scan ${name}.`);
    case 'running':
      return notice(
        'active',
        scan.repository?.provider === 'github'
          ? `Scanning ${name}: downloading only the candidate files of its latest commit (read-only)…`
          : `Scanning ${name} (read-only, working tree)…`,
      );
    case 'failed':
      // A scan that could not run keeps its typed outcome, whose message explains it.
      if (scan.result && !scan.result.ok) return notice('error', scan.result.message);
      return notice('error', `The scan failed: ${scan.error ?? 'unknown error'}`);
    case 'cancelled':
      // Cancellation is honoured only before the apply transaction commits (FR-105-17).
      return notice('error', 'The scan was cancelled. Nothing was changed.');
    case 'interrupted':
      // A shutdown timeout or a crash can land after the apply committed, so this cannot promise
      // that nothing changed — only that the apply is all or nothing.
      return notice(
        'error',
        "The runner stopped before it recorded the scan's outcome. A scan stores its changes completely or not at all; scan again to make sure the registry is up to date.",
      );
    case 'completed':
      break;
  }
  const result = scan.result;
  if (!result) return notice('error', 'The runner finished without a result.');
  if (!result.ok) return notice('error', result.message);
  return {
    kind: 'done',
    message:
      `Scanned ${name}${result.commitSha ? ` at commit ${result.commitSha.slice(0, 12)}` : ''}: ` +
      `${plural(result.scannedFiles, 'file')} in ${formatDuration(result.durationMs)}, ` +
      `${plural(result.discovered, 'artifact')} found (${result.createdArtifacts} new, ` +
      `${plural(result.createdVersions, 'new version')}), ${plural(result.errorCount, 'error')}.`,
    errors: result.errors,
    errorCount: result.errorCount,
    info: skippedFoldersInfo(result.skippedUserLevelFolders),
  };
}

/** The line about user-level agent folders a scan skipped (D05), or null when it skipped none. */
function skippedFoldersInfo(folders: readonly string[]): string | null {
  if (folders.length === 0) return null;
  if (folders.includes('.')) {
    return 'This location is a user-level agent folder; those are never scanned, so nothing was read.';
  }
  return `Skipped user-level agent folders, which are never scanned: ${folders.join(', ')}.`;
}

/** Why the Scan button could not enqueue a scan (`?scanError=` from the action). */
const SCAN_REQUEST_ERRORS = new Map<string, string>([
  ['invalid', 'The scan request was invalid. Reload the page and click Scan again.'],
  ['not-found', 'That repository no longer exists. It may have been removed; reload the list.'],
  [
    'unsupported',
    'That repository cannot be scanned yet: only local and GitHub repositories can be scanned.',
  ],
]);

/** The page-level error for `?scanError=`, or null for no or an unknown value. */
export function scanRequestError(code: string | undefined): string | null {
  return code === undefined ? null : (SCAN_REQUEST_ERRORS.get(code) ?? null);
}
