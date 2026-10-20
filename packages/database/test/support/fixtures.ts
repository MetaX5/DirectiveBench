import { sha256 } from '@directivebench/core';
import {
  createBenchmarkRun,
  importArtifactVersion,
  importSuiteVersion,
  registerLocalRepository,
  type CreateBenchmarkRunInput,
  type LocalRepositoryRegistration,
  type DatabaseHandle,
  type ImportArtifactInput,
  type ImportSuiteInput,
} from '../../src/index';

export function artifactInput(
  content: string,
  overrides: Partial<ImportArtifactInput> = {},
): ImportArtifactInput {
  return {
    repository: { provider: 'local-directory', name: 'fixtures', location: '/tmp/fixtures' },
    path: 'skills/validate',
    slug: 'validate',
    // Bundled-example identity also matches by name, so a distinct slug implies a distinct name.
    name: overrides.slug ?? 'validate',
    type: 'skill',
    description: 'Validate input',
    format: 'skill-md',
    primaryFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
    parsedMetadata: {},
    ...overrides,
  };
}

export function suiteInput(
  contentHash: string,
  overrides: Partial<ImportSuiteInput> = {},
): ImportSuiteInput {
  return {
    slug: 'suite',
    name: 'Suite',
    description: null,
    schemaVersion: 1,
    definition: { id: 'suite' },
    fixtures: {},
    contentHash,
    sourcePath: null,
    approval: null,
    ...overrides,
  };
}

export interface SeededTargets {
  artifactId: string;
  artifactVersionId: string;
  suiteId: string;
  suiteVersionId: string;
}

/** Imports one artifact version and one suite version, the minimum a job or run references. */
export async function seedTargets(
  handle: DatabaseHandle,
  options: { artifact?: Partial<ImportArtifactInput>; suite?: Partial<ImportSuiteInput> } = {},
): Promise<SeededTargets> {
  const artifact = await importArtifactVersion(handle, artifactInput('v1', options.artifact));
  const suite = await importSuiteVersion(handle, suiteInput('h', options.suite));
  return {
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.versionId,
    suiteId: suite.suiteId,
    suiteVersionId: suite.versionId,
  };
}

export function runInput(
  targets: Pick<SeededTargets, 'artifactVersionId' | 'suiteVersionId'>,
  overrides: Partial<CreateBenchmarkRunInput> = {},
): CreateBenchmarkRunInput {
  return {
    jobId: null,
    suiteVersionId: targets.suiteVersionId,
    artifactVersionId: targets.artifactVersionId,
    agentAdapterId: 'mock',
    agentVersion: null,
    model: null,
    environment: {},
    ...overrides,
  };
}

/** Creates a benchmark run; callers control `startedAt` through fake system time. */
export function seedRun(
  handle: DatabaseHandle,
  targets: Pick<SeededTargets, 'artifactVersionId' | 'suiteVersionId'>,
  overrides: Partial<CreateBenchmarkRunInput> = {},
): Promise<string> {
  return createBenchmarkRun(handle.db, runInput(targets, overrides));
}

/** The home directory registration tests pass as the confirmation scope (FR-104-18). */
export const TEST_HOME = '/home/tester';

/**
 * Registers a local repository that needs no confirmation (or whose location was confirmed) and
 * returns the registered outcome; throws when the registration asks for a confirmation.
 */
export async function registerLocal(
  handle: DatabaseHandle,
  input: Partial<LocalRepositoryRegistration> & Pick<LocalRepositoryRegistration, 'location'>,
  confirmedLocation: string | null = null,
) {
  const outcome = await registerLocalRepository(
    handle,
    { provider: 'local-directory', name: 'repo', defaultBranch: null, ...input },
    { homeDirectory: TEST_HOME, confirmedLocation },
  );
  if (outcome.status !== 'registered') throw new Error(`${input.location} needs a confirmation`);
  return outcome;
}
