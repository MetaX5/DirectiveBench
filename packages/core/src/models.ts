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
