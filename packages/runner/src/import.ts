import { basename, dirname } from 'node:path';
import { prepareSuiteImport } from '@directivebench/benchmark-engine';
import { loadLocalArtifact } from '@directivebench/core';
import {
  assignBenchmarkSuite,
  assignCategoriesBySlug,
  importArtifactVersion,
  importSuiteVersion,
  recordFixtureVersion,
  type DatabaseHandle,
  type RepositoryRef,
} from '@directivebench/database';

export interface ImportedArtifact {
  artifactId: string;
  versionId: string;
  version: number;
  createdVersion: boolean;
  name: string;
  warnings: string[];
}

/** Imports one artifact from a local directory (read-only; nothing in it is executed). */
export async function importLocalArtifact(
  handle: DatabaseHandle,
  source: RepositoryRef,
  relPath: string,
  categories: readonly string[] = [],
): Promise<ImportedArtifact> {
  const loaded = await loadLocalArtifact(source.location, relPath);
  const result = await importArtifactVersion(handle, {
    repository: source,
    path: loaded.path,
    slug: loaded.slug,
    name: loaded.parsed.name,
    type: loaded.parsed.type,
    description: loaded.parsed.description,
    format: loaded.parsed.format,
    primaryFile: loaded.primaryFile,
    files: loaded.files,
    contentHash: loaded.contentHash,
    parsedMetadata: {
      frontmatter: loaded.parsed.frontmatter,
      activation: loaded.parsed.activation,
      references: loaded.parsed.references,
      warnings: loaded.warnings,
    },
  });
  if (categories.length > 0) await assignCategoriesBySlug(handle.db, result.artifactId, categories);
  return { ...result, name: loaded.parsed.name, warnings: loaded.warnings };
}

export interface ImportedSuite {
  suiteId: string;
  versionId: string;
  version: number;
  createdVersion: boolean;
  name: string;
}

/**
 * Validates a benchmark definition, snapshots its fixtures into the data directory and stores
 * an immutable suite version. `approval` is only granted for trusted sources (bundled examples).
 */
export async function importBenchmarkSuite(
  handle: DatabaseHandle,
  definitionPath: string,
  fixtureStore: string,
  approval: 'bundled-example' | null,
): Promise<ImportedSuite> {
  const prepared = await prepareSuiteImport(definitionPath, fixtureStore);
  for (const snapshot of prepared.snapshots) {
    await recordFixtureVersion(handle.db, {
      id: snapshot.hash,
      sourcePath: snapshot.sourcePath,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
    });
  }
  const result = await importSuiteVersion(handle, {
    slug: prepared.definition.id,
    name: prepared.definition.name,
    description: prepared.definition.description ?? null,
    schemaVersion: prepared.definition.schemaVersion,
    definition: prepared.definition as unknown as Record<string, unknown>,
    fixtures: prepared.fixtures,
    contentHash: prepared.contentHash,
    sourcePath: `${basename(dirname(prepared.sourcePath))}/${basename(prepared.sourcePath)}`,
    approval,
  });
  return { ...result, name: prepared.definition.name };
}

export interface ExampleImportResult {
  artifact: ImportedArtifact;
  suite: ImportedSuite;
}

/** Imports the executable bundled example (skill + mock benchmark) and links them. */
export async function importBundledExample(
  handle: DatabaseHandle,
  examplesDir: string,
  fixtureStore: string,
): Promise<ExampleImportResult> {
  const artifact = await importLocalArtifact(
    handle,
    {
      provider: 'bundled-examples',
      name: 'Bundled examples',
      location: `${examplesDir}/artifacts`,
    },
    'validate-external-input/SKILL.md',
    ['security', 'code-quality'],
  );
  const suite = await importBenchmarkSuite(
    handle,
    `${examplesDir}/benchmarks/mock-input-validation/benchmark.yaml`,
    fixtureStore,
    'bundled-example',
  );
  await assignBenchmarkSuite(handle.db, artifact.artifactId, suite.suiteId);
  return { artifact, suite };
}
