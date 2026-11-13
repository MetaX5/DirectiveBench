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
  type RepositoryRemovalImpact,
  type RepositoryRegistration,
  type RepositoryRegistrationResult,
  type RepositoryScan,
} from '@directivebench/database';
import { z } from 'zod';
import { INCOMPLETE_FORM_MESSAGE } from './artifact-metadata';
import { formatCount, formatDate, formatDuration } from './utils';

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

/**
 * How the UI names one repository: name, provider and location (issue 215, decision E1). Only
 * provider plus location is unique (`repositories_provider_location_unique`); a name repeats for
 * two folders called `skills`, and one directory can be a local directory and a local Git
 * repository at once. The registration result, the removal question, the row buttons and a
 * shared name in the `/artifacts` repository filter all use this one format.
 */
export function repositorySubject(
  repository: Pick<RepositoryRecord, 'name' | 'provider' | 'location'>,
): string {
  return `${repository.name} (${providerLabel(repository.provider)}, ${repository.location})`;
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
        // The runner stores a complete sentence: a fixed message for an unexpected failure
        // (FR-114-10) or the reason the stored request is invalid.
        message: registration.error ?? 'The check failed.',
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
  const subject = repositorySubject(repository);
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

/**
 * What the Repositories page says about a scan job; `active` keeps the page refreshing. `warning`
 * is a completed scan that asks the user to check something: the empty-scan guard kept the
 * occurrences found before (SPEC-125 A7, §11.2 D6b).
 */
export interface ScanNotice {
  kind: 'active' | 'done' | 'warning' | 'error';
  message: string;
  /** Discovery errors to list (path, code, message); empty unless the scan completed. */
  errors: { path: string; code: string; message: string }[];
  /** How many errors the scan found in total (the list is capped). */
  errorCount: number;
  /** One informational line, e.g. the user-level folders the scan skipped; not an error. */
  info: string | null;
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The SPEC-125 sentences after a completed scan's counts (FR-125-12, §11.2 D6 and D6a): how many
 * occurrences went missing and were found again, each only when above 0, or, after an empty scan
 * that kept the occurrences found before (A7), why nothing was marked. Empty when there is none.
 */
function occurrenceChanges(result: {
  removedOccurrences: number;
  reactivatedOccurrences: number;
  emptyScanKeptOccurrences: number;
}): string {
  const kept = result.emptyScanKeptOccurrences;
  if (kept > 0) {
    const verb = kept === 1 ? 'was' : 'were';
    return ` No artifacts found, so the ${formatCount(kept)} found before ${verb} not marked missing. Check that the location is mounted and has the expected files. If they were deleted on purpose, remove the repository.`;
  }
  const clauses = [
    ...(result.removedOccurrences > 0
      ? [`${formatCount(result.removedOccurrences)} no longer found (marked missing)`]
      : []),
    ...(result.reactivatedOccurrences > 0
      ? [`${formatCount(result.reactivatedOccurrences)} found again`]
      : []),
  ];
  return clauses.length === 0 ? '' : ` ${clauses.join(', ')}.`;
}

/**
 * The rule-3 clause inside the counts' parentheses (SPEC-126 FR-126-10, §11.3 F1): paths added to
 * an existing artifact instead of becoming new ones; empty when there were none.
 */
function matchedClause(linked: number): string {
  return linked > 0 ? `${formatCount(linked)} matched an existing artifact, ` : '';
}

/**
 * The sentence for links that chose the oldest of several artifacts (A7, §11.3 F2); empty when
 * there were none.
 */
function ambiguousLinksSentence(ambiguous: number): string {
  if (ambiguous === 0) return '';
  const verb = ambiguous === 1 ? 'was' : 'were';
  return ` ${formatCount(ambiguous)} matched several existing artifacts and ${verb} added to the oldest one.`;
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
      // The runner stores a complete sentence (FR-114-10), so it is shown as it is.
      return notice('error', scan.error ?? 'The scan failed.');
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
    kind: result.emptyScanKeptOccurrences > 0 ? 'warning' : 'done',
    message:
      `Scanned ${name}${result.commitSha ? ` at commit ${result.commitSha.slice(0, 12)}` : ''}: ` +
      `${plural(result.scannedFiles, 'file')} in ${formatDuration(result.durationMs)}, ` +
      `${plural(result.discovered, 'artifact')} found (${formatCount(result.createdArtifacts)} new, ` +
      matchedClause(result.linkedOccurrences) +
      `${plural(result.createdVersions, 'new version')}), ${plural(result.errorCount, 'error')}.` +
      ambiguousLinksSentence(result.ambiguousLinks) +
      occurrenceChanges(result),
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

/**
 * Whether the Repositories page offers "Remove" for a repository: every one except the internal
 * `bundled-examples` repository, which `directivebench demo` re-imports (SPEC-125 A15, §11.3 D12).
 */
export function canRemove(repository: Pick<RepositoryRecord, 'provider'>): boolean {
  return repository.provider !== 'bundled-examples';
}

/** Why a removal did not happen (`?removeError=` from the action, SPEC-125 §10). */
export type RemoveErrorCode = 'not-found' | 'invalid' | 'failed';

/** The removal state the Repositories page reads from its URL (SPEC-125 §10). */
export interface RemovalParams {
  /** The repository whose Risky-action panel to show (`?remove=`). */
  remove: string | null;
  /** The counts of a completed removal (`?removedOccurrences=&missingArtifacts=`). */
  removed: { occurrences: number; missingArtifacts: number } | null;
  error: RemoveErrorCode | null;
}

const repositoryIdSchema = z.string().regex(/^repo_[A-Za-z0-9_-]{1,64}$/);
/** A plain decimal count; `z.coerce` would also take '', ' 1', '1e3' or '0x10'. */
const countSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const removeErrorSchema = z.enum(['not-found', 'invalid', 'failed']);

/** The parsed value, or null when the parameter is missing, repeated or invalid. */
function parsed<T>(schema: z.ZodType<T, unknown>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Parses the removal parameters (SPEC-125 §10). Each one is checked on its own and an invalid or
 * repeated value is ignored; the counts count only as a pair.
 */
export function parseRemovalParams(params: {
  remove?: string | string[];
  removedOccurrences?: string | string[];
  missingArtifacts?: string | string[];
  removeError?: string | string[];
}): RemovalParams {
  const occurrences = parsed(countSchema, params.removedOccurrences);
  const missingArtifacts = parsed(countSchema, params.missingArtifacts);
  return {
    remove: parsed(repositoryIdSchema, params.remove),
    removed:
      occurrences !== null && missingArtifacts !== null ? { occurrences, missingArtifacts } : null,
    error: parsed(removeErrorSchema, params.removeError),
  };
}

/**
 * The reasons of the removal panel (SPEC-125 FR-125-15, §11.3 D15), each one sentence (the last
 * two for a local repository, SPEC-126 §11.3 F8), in order: what is deleted, what becomes
 * missing, what is not touched, and what registering it again does.
 * A repository without occurrences shows only the first and the location reason.
 */
export function removalReasons(impact: RepositoryRemovalImpact): string[] {
  const hosted = impact.provider === 'github' || impact.provider === 'gitlab';
  const location = hosted
    ? `The copy downloaded from ${providerLabel(impact.provider)} stays in DirectiveBench's cache. Deleting it is planned.`
    : `Nothing in ${impact.location} is changed.`;
  if (impact.occurrences === 0) return ['It has no occurrences.', location];
  const missing = impact.artifactsLeftMissing;
  return [
    impact.occurrences === 1
      ? 'Its 1 occurrence is deleted from DirectiveBench.'
      : `Its ${formatCount(impact.occurrences)} occurrences are deleted from DirectiveBench.`,
    missing === 0
      ? 'Every artifact found here is also found in another repository, or is already missing.'
      : missing === 1
        ? '1 artifact is then missing from every repository. Its versions, categories, notes and benchmark results are kept.'
        : `${formatCount(missing)} artifacts are then missing from every repository. Their versions, categories, notes and benchmark results are kept.`,
    location,
    // Hosted copies never link (SPEC-126 A16), so only a local repository's files can match an
    // artifact still recorded elsewhere (§11.3 F8).
    hosted
      ? 'Registering it again later creates new artifacts instead of reusing these ones.'
      : 'Registering it again later creates new artifacts. A skill or rule whose exact content is still recorded in another local repository is matched to its existing artifact instead.',
  ];
}

/** A removal line on the Repositories page (§11.3 D18): `done` is green, `error` an alert. */
export interface RemovalLine {
  kind: 'done' | 'error' | 'info';
  message: string;
}

const REMOVE_ERRORS: Record<RemoveErrorCode, string> = {
  'not-found': 'That repository is no longer registered. Nothing was removed.',
  invalid: INCOMPLETE_FORM_MESSAGE,
  failed: 'The repository could not be removed. Nothing was changed.',
};

/** The success line for a completed removal (§11.3 D18). */
function removedMessage(removed: { occurrences: number; missingArtifacts: number }): string {
  if (removed.occurrences === 0) return 'Repository removed. It had no occurrences.';
  const deleted = plural(removed.occurrences, 'occurrence');
  if (removed.missingArtifacts === 0)
    return `Repository removed: ${deleted} deleted. No artifact became missing.`;
  const history = removed.missingArtifacts === 1 ? 'Its' : 'Their';
  return `Repository removed: ${deleted} deleted, ${plural(removed.missingArtifacts, 'artifact')} now missing from every repository. ${history} history is kept.`;
}

/**
 * The one removal line the page shows, or null (SPEC-125 §10, §13, §11.3 D18): an error wins over
 * a result, and `?remove=` for a repository that is not registered says so. `unknownTarget` is
 * true only for an id the page does not list (not for `bundled-examples`, which shows nothing).
 */
export function removalResult(
  params: RemovalParams,
  options: { unknownTarget: boolean },
): RemovalLine | null {
  if (params.error) return { kind: 'error', message: REMOVE_ERRORS[params.error] };
  if (params.removed) return { kind: 'done', message: removedMessage(params.removed) };
  if (params.remove !== null && options.unknownTarget)
    return { kind: 'info', message: 'That repository is no longer registered.' };
  return null;
}
