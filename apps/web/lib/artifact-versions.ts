// Labels and the copy helper of the artifact page's Versions tab (SPEC-103 §11, issue 65).
// The copy button is a client component, so this module imports nothing from
// `@directivebench/core` (lesson 2026-11-05-client-components-must-not-import-core).

/** Characters of the content hash shown in the table; the copy button gives the full hash. */
export const SHORT_HASH_LENGTH = 16;
/** Characters of a commit SHA in the first-seen label, as git abbreviates it by default. */
export const SHORT_COMMIT_LENGTH = 7;

export function shortHash(hash: string): string {
  return `${hash.slice(0, SHORT_HASH_LENGTH)}…`;
}

export const HASH_EXPLANATION = 'SHA-256 over the sorted file manifest';

export interface VersionProvenance {
  sourceRepositoryId: string | null;
  sourcePath: string | null;
  sourceCommitSha: string | null;
}

/**
 * Where a version was first observed, as `<repository>:<path>@<short commit>` (SPEC-103 §11,
 * FR-103-15). A working-tree scan records no commit, so the `@` part is left out; a repository
 * that no longer exists reads "Unknown repository".
 */
export function firstSeenLabel(
  version: VersionProvenance,
  repositories: readonly { id: string; name: string }[],
): string {
  const repository =
    repositories.find((r) => r.id === version.sourceRepositoryId)?.name ?? 'Unknown repository';
  const path = version.sourcePath === null ? '' : `:${version.sourcePath}`;
  const commit =
    version.sourceCommitSha === null
      ? ''
      : `@${version.sourceCommitSha.slice(0, SHORT_COMMIT_LENGTH)}`;
  return `${repository}${path}${commit}`;
}

export type CopyResult = 'copied' | 'failed';

/**
 * Writes `text` to the clipboard. The Clipboard API exists only in a secure context (HTTPS,
 * localhost or 127.0.0.1) and the browser may refuse the write, so both end in `failed` and the
 * caller shows the text instead.
 */
export async function copyText(
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
  text: string,
): Promise<CopyResult> {
  if (!clipboard) return 'failed';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    // Not swallowed: the caller reports the failure and shows the hash to copy by hand.
    return 'failed';
  }
}

export function copyStatusMessage(result: CopyResult, hash: string): string {
  return result === 'copied'
    ? 'Copied.'
    : `Not copied: the browser blocked the clipboard. Full hash: ${hash}`;
}
