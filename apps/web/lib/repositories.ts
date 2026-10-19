import { repositoryPathInputSchema } from '@directivebench/core';
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

/** The field error for a path the action sent back (`?path=`), or null when it is valid. */
export function pathFieldError(path: string): string | null {
  const parsed = repositoryPathInputSchema.safeParse(path);
  return parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join(' ');
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
 * same files counted as occurrences of two repositories.
 */
export function confirmationReasons(request: ConfirmationRequest): string[] {
  const reasons: string[] = [];
  if (request.home === 'home') {
    reasons.push(
      'This is your home directory. A scan reads every file below it (except .git and node_modules), which can take long, and includes user-level folders such as ~/.claude/skills and the skills of every project in it.',
    );
  } else if (request.home === 'contains-home') {
    reasons.push(
      'This directory contains your home directory. A scan reads every file below it (except .git and node_modules), which can take very long, and includes user-level folders such as ~/.claude/skills.',
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
  const { path, status, result } = registration;
  switch (status) {
    case 'pending':
      return {
        kind: 'active',
        path,
        message: `Waiting for the runner to check ${path}. It runs inside directivebench serve.`,
      };
    case 'running':
      return { kind: 'active', path, message: `Checking ${path} (read-only)…` };
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
        message: 'The runner stopped before the check finished. Register the path again.',
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

/** Whether the Repositories page offers "Scan" for a repository (local providers only so far). */
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
  });
  switch (scan.status) {
    case 'pending':
      return notice('active', `Waiting for the runner to scan ${name}.`);
    case 'running':
      return notice('active', `Scanning ${name} (read-only, working tree)…`);
    case 'failed':
      return notice('error', `The scan failed: ${scan.error ?? 'unknown error'}`);
    case 'cancelled':
      return notice('error', 'The scan was cancelled. Nothing was changed.');
    case 'interrupted':
      return notice('error', 'The runner stopped before the scan finished. Nothing was changed.');
    case 'completed':
      break;
  }
  const result = scan.result;
  if (!result) return notice('error', 'The runner finished without a result.');
  if (!result.ok) return notice('error', result.message);
  return {
    kind: 'done',
    message:
      `Scanned ${name}: ${plural(result.scannedFiles, 'file')} in ${formatDuration(result.durationMs)}, ` +
      `${plural(result.discovered, 'artifact')} found (${result.createdArtifacts} new, ` +
      `${plural(result.createdVersions, 'new version')}), ${plural(result.errorCount, 'error')}.`,
    errors: result.errors,
    errorCount: result.errorCount,
  };
}
