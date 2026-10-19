'use server';

import { executionBlockers } from '@directivebench/benchmark-engine/definition';
import { validateDefinition } from '@directivebench/benchmark-engine/load';
import { MAX_REPOSITORY_PATH_LENGTH, repositoryPathInputSchema } from '@directivebench/core';
import {
  enqueueBenchmarkJob,
  enqueueRepositoryRegistrationJob,
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
 * and enqueues a `repository-registration` job; the runner in the CLI process resolves the path
 * and runs git read-only. Invalid input returns to the form with a field-level error.
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
  const job = await enqueueRepositoryRegistrationJob(requireDatabase().db, {
    path: input.data.path,
  });
  revalidatePath('/repositories');
  redirect(`/repositories?registration=${encodeURIComponent(job.id)}`);
}
