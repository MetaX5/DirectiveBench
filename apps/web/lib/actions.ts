'use server';

import { executionBlockers } from '@directivebench/benchmark-engine/definition';
import { validateDefinition } from '@directivebench/benchmark-engine/load';
import {
  MAX_REPOSITORY_PATH_LENGTH,
  repositoryLocationSchema,
  repositoryPathInputSchema,
} from '@directivebench/core';
import {
  enqueueBenchmarkJob,
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  NotFoundError,
  UnsupportedRepositoryError,
  getLatestArtifactVersionId,
  getSuiteVersion,
  requestJobCancellation,
} from '@directivebench/database';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireDatabase } from './db';

const enqueueSchema = z.object({
  suiteVersionId: z.string().min(1),
  artifactId: z.string().min(1),
});

/**
 * Enqueues a benchmark run for the latest version of an artifact. The suite version must exist,
 * be valid and be runnable in this build (environment, execution approval) — checked here,
 * before enqueueing (FR-114-02), with the same rules the runner enforces. The runner in the CLI
 * process executes the job; the web server never executes benchmarks.
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
    ? executionBlockers(validation.definition, Boolean(suiteVersion.version.executionApprovedAt))
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
 * Registers a local repository by path (SPEC-104 §9). The web process only validates the field
 * and enqueues a `repository-registration` job; the runner in the CLI process resolves the path,
 * runs git read-only and decides whether the canonical location needs a confirmation
 * (FR-104-18). Invalid input returns to the form with a field-level error.
 */
export async function registerRepositoryAction(formData: FormData): Promise<void> {
  const raw = formData.get('path');
  const input = registerRepositorySchema.safeParse({ path: raw });
  if (!input.success) {
    // Only the entered path travels back; the page re-validates it to show the field error, so
    // no free text from the URL is ever rendered as an error message. One character over the
    // limit is enough to reproduce "too long" without building an oversized URL.
    const echoed = typeof raw === 'string' ? raw.slice(0, MAX_REPOSITORY_PATH_LENGTH + 1) : '';
    const params = new URLSearchParams({ path: echoed });
    redirect(`/repositories?${params.toString()}`);
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
