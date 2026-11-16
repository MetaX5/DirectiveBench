import type { DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import { suiteSubject } from './artifact-metadata';
import { DISPLAY_STATUS_LABELS } from './run-status';

// Accessible names of per-row controls (issues 227 and 228). Rows repeat a verb ("Run", "Cancel")
// or a name (artifact and suite names repeat, SPEC-126, issue 219), so each name adds what is
// unique for its target, in the #219/#220 format: a comma and a label, never parentheses (names
// often end in parentheses). Each name starts with the visible text, so voice control finds it.

/** An artifact in an accessible name: its name, then its slug (the slug is unique). */
export function artifactSubject(artifact: { name: string; slug: string }): string {
  return `${artifact.name}, slug ${artifact.slug}`;
}

/** The suite page's per-artifact "Run" button (issue 228, K7). */
export function runOnArtifactName(artifact: { name: string; slug: string }): string {
  return `Run on ${artifactSubject(artifact)}`;
}

/** The Executions page's per-job "Cancel" button (issue 228, K8). */
export function cancelJobName(jobId: string): string {
  return `Cancel job ${jobId}`;
}

/**
 * The Executions page's per-job "View run" link (issue 228, K8): "of job", since the link goes to
 * a run with its own ID, which the row does not show.
 */
export function viewRunOfJobName(jobId: string): string {
  return `View run of job ${jobId}`;
}

/** The Artifacts list's Status link to an artifact's latest run (issue 227, extra scope). */
export function latestRunStatusName(
  status: DisplayStatus,
  artifact: { name: string; slug: string },
): string {
  return `${DISPLAY_STATUS_LABELS[status]}, latest run of ${artifactSubject(artifact)}`;
}

/** The Results list's Artifact link to one run (issue 227, extra scope). */
export function resultRunName(artifactName: string, runId: string): string {
  return `${artifactName}, run ${runId}`;
}

/**
 * A link named by a suite name: the name with the suite ID when another suite has the same name
 * (issue 227), else undefined, so the link keeps its visible text as its name.
 */
export function suiteLinkName(suite: {
  name: string;
  slug: string;
  nameShared: boolean;
}): string | undefined {
  return suite.nameShared ? suiteSubject(suite) : undefined;
}
