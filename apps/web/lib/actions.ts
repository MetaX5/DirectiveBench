'use server';

import {
  enqueueBenchmarkJob,
  getLatestArtifactVersionId,
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
 * Enqueues a benchmark run for the latest version of an artifact. The runner in the CLI
 * process picks it up; the web server never executes benchmarks.
 */
export async function enqueueBenchmarkRunAction(formData: FormData): Promise<void> {
  const input = enqueueSchema.parse({
    suiteVersionId: formData.get('suiteVersionId'),
    artifactId: formData.get('artifactId'),
  });
  const { db } = requireDatabase();
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
