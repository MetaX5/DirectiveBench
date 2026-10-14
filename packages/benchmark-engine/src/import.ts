import { dirname, resolve } from 'node:path';
import { canonicalJson, sha256 } from '@directivebench/core';
import type { BenchmarkDefinition } from './definition';
import { snapshotDirectory, type Snapshot } from './files';
import { loadDefinitionFile } from './load';

export interface CaseFixtures {
  fixture: string;
  overlay?: string;
}

export interface PreparedSuite {
  definition: BenchmarkDefinition;
  /** Fixture snapshot hashes per case id. */
  fixtures: Record<string, CaseFixtures>;
  snapshots: (Snapshot & { sourcePath: string })[];
  /** Hash over the definition and fixture hashes; identical content ⇒ identical suite version. */
  contentHash: string;
  sourcePath: string;
}

export function suiteContentHash(
  definition: BenchmarkDefinition,
  fixtures: Record<string, CaseFixtures>,
): string {
  return sha256(canonicalJson({ definition, fixtures }));
}

/**
 * Loads a definition file and snapshots every referenced fixture and verification overlay into
 * the content-addressed fixture store. Paths are resolved relative to the definition file.
 */
export async function prepareSuiteImport(
  definitionPath: string,
  fixtureStore: string,
): Promise<PreparedSuite> {
  const sourcePath = resolve(definitionPath);
  const definition = await loadDefinitionFile(sourcePath);
  const baseDir = dirname(sourcePath);
  const fixtures: Record<string, CaseFixtures> = {};
  const snapshots: PreparedSuite['snapshots'] = [];
  for (const benchmarkCase of definition.cases) {
    const fixturePath = resolve(baseDir, benchmarkCase.fixture.path);
    const fixture = await snapshotDirectory(fixturePath, fixtureStore);
    snapshots.push({ ...fixture, sourcePath: fixturePath });
    const entry: CaseFixtures = { fixture: fixture.hash };
    if (benchmarkCase.verification) {
      const overlayPath = resolve(baseDir, benchmarkCase.verification.overlay);
      const overlay = await snapshotDirectory(overlayPath, fixtureStore);
      snapshots.push({ ...overlay, sourcePath: overlayPath });
      entry.overlay = overlay.hash;
    }
    fixtures[benchmarkCase.id] = entry;
  }
  return {
    definition,
    fixtures,
    snapshots,
    contentHash: suiteContentHash(definition, fixtures),
    sourcePath,
  };
}
