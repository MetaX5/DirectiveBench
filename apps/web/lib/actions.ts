'use server';

import { validateDefinition } from '@directivebench/benchmark-engine/load';
import {
  MAX_REPOSITORY_PATH_LENGTH,
  MAX_REPOSITORY_URL_LENGTH,
  looksLikeRepositoryUrl,
  parseRepositoryUrl,
  repositoryLocationSchema,
  repositoryPathInputSchema,
} from '@directivebench/core';
import {
  addArtifactTag,
  assignArtifactSuite,
  enqueueBenchmarkJob,
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  NotFoundError,
  UnsupportedRepositoryError,
  getLatestArtifactVersionId,
  getSuiteVersion,
  removeArtifactTag,
  requestJobCancellation,
  setArtifactNotes,
  unassignArtifactSuite,
  type ArtifactSuiteOutcome,
} from '@directivebench/database';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  addTagSchema,
  ARTIFACT_GONE_MESSAGE,
  fieldText,
  INCOMPLETE_FORM_MESSAGE,
  metadataLimits,
  notesSchema,
  refused,
  removeTagSchema,
  SUITE_GONE_MESSAGE,
  suiteAssignmentSchema,
  type MetadataFormState,
} from './artifact-metadata';
import { requireDatabase } from './db';
import { webRunBlockers } from './run-guard';
import {
  looksLikeProtocolRelativeUrl,
  mayCarryCredentials,
  type RejectedInputCode,
} from './repositories';

const enqueueSchema = z.object({
  suiteVersionId: z.string().min(1),
  artifactId: z.string().min(1),
});

/**
 * Enqueues a benchmark run for the latest version of an artifact. The suite version must exist,
 * be valid, use the mock agent (real agents run only from the CLI, SPEC-118 FR-118-05) and be
 * runnable in this build (environment, execution approval) — checked here, before enqueueing
 * (FR-114-02), with the same rules the runner enforces. The runner in the CLI process executes
 * the job; the web server never executes benchmarks.
 */
export async function enqueueBenchmarkRunAction(formData: FormData): Promise<void> {
  const input = enqueueSchema.parse({
    suiteVersionId: formData.get('suiteVersionId'),
    artifactId: formData.get('artifactId'),
  });
  const { db } = requireDatabase();
  const suiteVersion = await getSuiteVersion(db, input.suiteVersionId);
  if (!suiteVersion) throw new Error('Suite version not found');
  const validation = validateDefinition(suiteVersion.version.definition);
  const blockers = validation.success
    ? webRunBlockers(validation.definition, Boolean(suiteVersion.version.executionApprovedAt))
    : ['The stored benchmark definition is invalid.'];
  if (blockers.length > 0) {
    redirect(
      `/benchmarks/${suiteVersion.suite.id}?error=${encodeURIComponent(blockers.join(' '))}`,
    );
  }
  const artifactVersionId = await getLatestArtifactVersionId(db, input.artifactId);
  if (!artifactVersionId) throw new Error('Artifact has no versions');
  await enqueueBenchmarkJob(db, { suiteVersionId: input.suiteVersionId, artifactVersionId });
  revalidatePath('/executions');
  redirect('/executions');
}

export async function cancelJobAction(formData: FormData): Promise<void> {
  const jobId = z.string().min(1).parse(formData.get('jobId'));
  await requestJobCancellation(requireDatabase().db, jobId);
  revalidatePath('/executions');
}

const registerRepositorySchema = z.object({ path: repositoryPathInputSchema });

/**
 * Sends rejected input back to the form (SPEC-104 FR-104-05). Input that may carry credentials
 * goes back without itself, only with the fixed reason code, so it never lands in the browser
 * history or a request log; other input is echoed, up to one character over `limit` (enough to
 * reproduce "too long" without building an oversized URL), and the page re-validates it to show
 * the field error. Both the URL and the path branch return through here, so a malformed URL that
 * falls through to path validation is guarded the same way.
 */
function returnToForm(value: string, code: RejectedInputCode, limit: number): never {
  const params = new URLSearchParams(
    mayCarryCredentials(value) ? { urlError: code } : { path: value.trim().slice(0, limit + 1) },
  );
  redirect(`/repositories?${params.toString()}`);
}

/**
 * Registers a public GitHub repository by URL (SPEC-104 FR-104-02, FR-104-05): only its
 * normalised, credential-free location is enqueued, and the runner asks the remote for the
 * default branch. A rejected URL goes back to the form (see `returnToForm`).
 */
async function registerUrl(value: string): Promise<never> {
  const parsed = parseRepositoryUrl(value);
  if (!parsed.ok) returnToForm(value, parsed.code, MAX_REPOSITORY_URL_LENGTH);
  const job = await enqueueRepositoryRegistrationJob(requireDatabase().db, {
    url: parsed.location,
  });
  revalidatePath('/repositories');
  redirect(`/repositories?registration=${encodeURIComponent(job.id)}`);
}

/**
 * Registers a repository by local path or public GitHub URL (SPEC-104 §9). The web process only
 * validates the field and enqueues a `repository-registration` job; the runner in the CLI
 * process resolves the path (or asks GitHub), runs git read-only and, for paths, decides whether
 * the canonical location needs a confirmation (FR-104-18). Invalid input returns to the form with
 * a field-level error; a valid path is registered as entered, `@`, `?` or `#` included.
 */
export async function registerRepositoryAction(formData: FormData): Promise<void> {
  const raw = formData.get('path');
  if (typeof raw === 'string' && looksLikeRepositoryUrl(raw)) return registerUrl(raw);
  // `//github.com/a/b?access_token=…` is a valid absolute path but reads as a protocol-relative
  // URL: with characters that can carry credentials it is refused instead of being stored as
  // typed. Without them (`//srv/share`: a UNC path on Windows, an ordinary absolute path on POSIX)
  // it is still registered as a path.
  if (typeof raw === 'string' && looksLikeProtocolRelativeUrl(raw) && mayCarryCredentials(raw)) {
    returnToForm(raw, 'invalid-url', MAX_REPOSITORY_URL_LENGTH);
  }
  const input = registerRepositorySchema.safeParse({ path: raw });
  if (!input.success) {
    // A missing field or a file upload is not echoed at all.
    returnToForm(typeof raw === 'string' ? raw : '', 'not-echoed', MAX_REPOSITORY_PATH_LENGTH);
  }
  // Present only when the user confirmed a broad or overlapping location (FR-104-18). An invalid
  // value is dropped, so the runner simply asks again; it never skips the check on its own.
  const confirmed = repositoryLocationSchema.safeParse(formData.get('confirmedLocation'));
  const job = await enqueueRepositoryRegistrationJob(requireDatabase().db, {
    path: input.data.path,
    ...(confirmed.success ? { confirmedLocation: confirmed.data } : {}),
  });
  revalidatePath('/repositories');
  redirect(`/repositories?registration=${encodeURIComponent(job.id)}`);
}

const scanRepositorySchema = z.object({ repositoryId: z.string().min(1) });

/** Enqueues the scan, or names why it cannot be scanned (the page shows a fixed message). */
async function enqueueScan(
  repositoryId: string,
): Promise<{ jobId: string } | { error: 'not-found' | 'unsupported' }> {
  try {
    const { job } = await enqueueRepositoryScanJob(requireDatabase(), { repositoryId });
    return { jobId: job.id };
  } catch (error) {
    if (error instanceof NotFoundError) return { error: 'not-found' };
    if (error instanceof UnsupportedRepositoryError) return { error: 'unsupported' };
    throw error;
  }
}

/**
 * Scans a registered local repository (SPEC-105 FR-105-01/02). The web process only enqueues a
 * `repository-scan` job — or finds the one already pending or running — and the runner in the CLI
 * process reads the files. A missing, unknown or non-local repository returns to the page with a
 * page-level error instead of an error page.
 */
export async function scanRepositoryAction(formData: FormData): Promise<void> {
  const input = scanRepositorySchema.safeParse({ repositoryId: formData.get('repositoryId') });
  const outcome = input.success ? await enqueueScan(input.data.repositoryId) : { error: 'invalid' };
  if ('error' in outcome) redirect(`/repositories?scanError=${outcome.error}`);
  revalidatePath('/repositories');
  redirect(`/repositories?scan=${encodeURIComponent(outcome.jobId)}`);
}

/** Re-renders the artifact page so the server components show what was saved. */
function refreshArtifact(artifactId: string): void {
  revalidatePath(`/artifacts/${artifactId}`);
}

/** Runs a write whose only expected failure is a deleted artifact (`NotFoundError`). */
async function onArtifact(write: () => Promise<MetadataFormState>): Promise<MetadataFormState> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof NotFoundError) return { kind: 'error', message: ARTIFACT_GONE_MESSAGE };
    throw error;
  }
}

/**
 * Adds one tag to an artifact (SPEC-101 FR-101-07, issue #64). The tag is trimmed and
 * lower-cased; a tag the artifact already has is reported, not added twice.
 */
export async function addArtifactTagAction(
  _previous: MetadataFormState,
  formData: FormData,
): Promise<MetadataFormState> {
  const value = fieldText(formData.get('tag'));
  const input = addTagSchema.safeParse({
    artifactId: formData.get('artifactId'),
    tag: formData.get('tag'),
  });
  if (!input.success) return refused(input.error, 'tag', value);
  const { artifactId, tag } = input.data;
  return onArtifact(async () => {
    const outcome = await addArtifactTag(requireDatabase(), artifactId, tag);
    if (outcome === 'limit') {
      return {
        kind: 'fieldError',
        message: `An artifact can have at most ${metadataLimits.tags} tags. Remove one first.`,
        value,
      };
    }
    refreshArtifact(artifactId);
    return outcome === 'added'
      ? { kind: 'success', message: `Added tag ${tag}.` }
      : { kind: 'success', message: `${tag} is already a tag.` };
  });
}

/** Removes one tag from an artifact (issue #64). */
export async function removeArtifactTagAction(
  _previous: MetadataFormState,
  formData: FormData,
): Promise<MetadataFormState> {
  const input = removeTagSchema.safeParse({
    artifactId: formData.get('artifactId'),
    tag: formData.get('tag'),
  });
  if (!input.success) return { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
  const { artifactId, tag } = input.data;
  return onArtifact(async () => {
    const removed = await removeArtifactTag(requireDatabase(), artifactId, tag);
    refreshArtifact(artifactId);
    return {
      kind: 'success',
      message: removed ? `Removed tag ${tag}.` : `${tag} was already removed.`,
    };
  });
}

/** Saves an artifact's notes; empty notes clear them (issue #64). */
export async function saveArtifactNotesAction(
  _previous: MetadataFormState,
  formData: FormData,
): Promise<MetadataFormState> {
  const value = fieldText(formData.get('notes'));
  const input = notesSchema.safeParse({
    artifactId: formData.get('artifactId'),
    notes: formData.get('notes'),
  });
  if (!input.success) return refused(input.error, 'notes', value);
  const { artifactId, notes } = input.data;
  return onArtifact(async () => {
    await setArtifactNotes(requireDatabase().db, artifactId, notes);
    refreshArtifact(artifactId);
    return { kind: 'success', message: notes === null ? 'Cleared the notes.' : 'Saved the notes.' };
  });
}

/** The message for a suite assignment outcome (issue #64). */
function suiteMessage(outcome: ArtifactSuiteOutcome): MetadataFormState {
  switch (outcome.status) {
    case 'missing-artifact':
      return { kind: 'error', message: ARTIFACT_GONE_MESSAGE };
    case 'missing-suite':
      return { kind: 'error', message: SUITE_GONE_MESSAGE };
    case 'assigned':
      return {
        kind: 'success',
        message: `Assigned ${outcome.suiteName}. Run it from its suite page.`,
      };
    case 'already-assigned':
      return { kind: 'success', message: `${outcome.suiteName} is already assigned.` };
    case 'unassigned':
      return {
        kind: 'success',
        message: `Unassigned ${outcome.suiteName}. Its results stay in Results by version.`,
      };
    case 'not-assigned':
      return { kind: 'success', message: `${outcome.suiteName} was already unassigned.` };
  }
}

/** Assigns one benchmark suite to an artifact (SPEC-101 FR-101-16, issue #64). */
export async function assignArtifactSuiteAction(
  _previous: MetadataFormState,
  formData: FormData,
): Promise<MetadataFormState> {
  const input = suiteAssignmentSchema.safeParse({
    artifactId: formData.get('artifactId'),
    suiteId: formData.get('suiteId'),
  });
  if (!input.success) return { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
  const { artifactId, suiteId } = input.data;
  const outcome = await assignArtifactSuite(requireDatabase(), artifactId, suiteId);
  refreshArtifact(artifactId);
  return suiteMessage(outcome);
}

/** Unassigns one benchmark suite; its runs and results stay (issue #64). */
export async function unassignArtifactSuiteAction(
  _previous: MetadataFormState,
  formData: FormData,
): Promise<MetadataFormState> {
  const input = suiteAssignmentSchema.safeParse({
    artifactId: formData.get('artifactId'),
    suiteId: formData.get('suiteId'),
  });
  if (!input.success) return { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
  const { artifactId, suiteId } = input.data;
  const outcome = await unassignArtifactSuite(requireDatabase(), artifactId, suiteId);
  refreshArtifact(artifactId);
  return suiteMessage(outcome);
}
