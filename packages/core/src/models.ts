import { z } from 'zod';
import type { ArtifactFormat, ArtifactType } from './artifacts';

/**
 * A model selection is independent of the agent harness that runs it (ADR 0006).
 * `provider` identifies a provider connection type (e.g. `anthropic`, `openai`); compatibility
 * between a harness and a provider/model is validated by the adapter, never assumed.
 */
export const modelSelectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** A single file belonging to an immutable artifact version. Text files only in the MVP. */
export interface ArtifactFile {
  /** POSIX path relative to the artifact root (e.g. `SKILL.md`, `scripts/check.sh`). */
  path: string;
  sha256: string;
  size: number;
  content: string;
}

/** Everything an agent adapter needs to install one exact artifact version into a workspace. */
export interface ArtifactBundle {
  artifactId: string;
  versionId: string;
  slug: string;
  name: string;
  type: ArtifactType;
  format: ArtifactFormat;
  contentHash: string;
  files: ArtifactFile[];
}

/**
 * The fields that decide whether one artifact version may be the A/B baseline of another. The
 * format is a plain string so stored rows (`artifact_versions.format`) can be checked directly.
 */
export interface BaselineIdentity {
  artifactId: string;
  versionId: string;
  format: string;
  contentHash: string;
}

/**
 * Why `baseline` cannot be the A/B baseline of `candidate`, or null when it can (SPEC-118
 * FR-118-12): another version of the same artifact, with other content and the same format.
 * Shared by the engine (`assertRunnable`) and the job repository, so the rule is checked before
 * a job exists and again when the runner loads it.
 */
export function baselineArtifactIssue(
  candidate: BaselineIdentity,
  baseline: BaselineIdentity,
): string | null {
  if (baseline.artifactId !== candidate.artifactId) {
    return 'The baseline must be another version of the same artifact as the candidate.';
  }
  if (baseline.versionId === candidate.versionId) {
    return 'The baseline is the candidate version itself; choose another version.';
  }
  if (baseline.contentHash === candidate.contentHash) {
    return 'The baseline version has the same content as the candidate; choose a version with other content.';
  }
  if (baseline.format !== candidate.format) {
    return `The baseline version has format ${baseline.format}, the candidate ${candidate.format}; both must have the same format.`;
  }
  return null;
}
