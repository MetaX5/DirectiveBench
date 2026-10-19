import { repositoryPathInputSchema } from '@directivebench/core';
import type { RepositoryRecord, RepositoryRegistration } from '@directivebench/database';

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
  | { kind: 'fieldError'; path: string; message: string };

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
