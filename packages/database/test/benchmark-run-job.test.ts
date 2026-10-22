import { describe, expect, it } from 'vitest';
import {
  approveSuiteVersion,
  createBenchmarkRunJob,
  getJob,
  getSuiteVersion,
  importArtifactVersion,
  InvalidBaselineError,
  schema,
  suiteVersionApproval,
  type BenchmarkRunJobInput,
} from '../src/index';
import { artifactInput, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

async function input(overrides: Partial<BenchmarkRunJobInput> = {}): Promise<BenchmarkRunJobInput> {
  const artifact = await importArtifactVersion(getHandle(), artifactInput('v1'));
  const { approval: _approval, ...suite } = suiteInput('content-1', {
    slug: 'pdf-benchmark',
    fixtures: { report: { fixture: 'f'.repeat(64) } },
  });
  return {
    fixtureVersions: [
      { id: 'f'.repeat(64), sourcePath: '/suite/fixtures/report', fileCount: 1, totalBytes: 9 },
    ],
    suite,
    approval: null,
    payload: { artifactVersionId: artifact.versionId, auth: { mode: 'subscription' } },
    runnerId: 'local-test-runner',
    ...overrides,
  };
}

async function count(
  table: typeof schema.jobs | typeof schema.benchmarkSuiteVersions | typeof schema.fixtureVersions,
) {
  return (await getHandle().db.select().from(table)).length;
}

describe('createBenchmarkRunJob (SPEC-118 FR-118-39)', () => {
  it('records fixtures, imports the suite version and creates the job acquired by the runner', async () => {
    const handle = getHandle();
    const created = await createBenchmarkRunJob(handle, await input());
    expect(created.suite).toMatchObject({ version: 1, createdVersion: true });
    expect(created.executionApproved).toBe(false);
    expect(created.job).toMatchObject({
      type: 'benchmark-run',
      status: 'running',
      runnerId: 'local-test-runner',
      payload: {
        suiteVersionId: created.suite.versionId,
        auth: { mode: 'subscription' },
      },
    });
    expect(await count(schema.fixtureVersions)).toBe(1);
    const stored = await getSuiteVersion(handle.db, created.suite.versionId);
    expect(stored?.version.executionApprovedAt).toBeNull();
  });

  it('reuses an unchanged suite version (FR-118-23)', async () => {
    const handle = getHandle();
    const first = await createBenchmarkRunJob(handle, await input());
    const again = await input();
    const second = await createBenchmarkRunJob(handle, {
      ...again,
      payload: first.job.payload as BenchmarkRunJobInput['payload'],
    });
    expect(second.suite).toMatchObject({ versionId: first.suite.versionId, createdVersion: false });
    expect(await count(schema.benchmarkSuiteVersions)).toBe(1);
    expect(await count(schema.jobs)).toBe(2);
  });

  it('records approval source user on this suite version only (FR-118-33)', async () => {
    const handle = getHandle();
    const created = await createBenchmarkRunJob(handle, await input({ approval: 'user' }));
    expect(created.executionApproved).toBe(true);
    const stored = await getSuiteVersion(handle.db, created.suite.versionId);
    expect(stored?.version.executionApprovalSource).toBe('user');
    expect(await suiteVersionApproval(handle.db, 'pdf-benchmark', 'content-1')).toBe(true);
    expect(await suiteVersionApproval(handle.db, 'pdf-benchmark', 'content-2')).toBeNull();
    expect(await suiteVersionApproval(handle.db, 'other', 'content-1')).toBeNull();
    // An approved version keeps its first approval.
    expect(await approveSuiteVersion(handle.db, created.suite.versionId, 'user', 'later')).toBe(
      false,
    );
  });

  it('keeps an earlier approval when this run asks for none', async () => {
    const handle = getHandle();
    await createBenchmarkRunJob(handle, await input({ approval: 'user' }));
    const again = await createBenchmarkRunJob(handle, await input());
    expect(again.executionApproved).toBe(true);
    expect(await suiteVersionApproval(handle.db, 'pdf-benchmark', 'content-1')).toBe(true);
  });

  it('rolls everything back when the job cannot be created', async () => {
    const handle = getHandle();
    const base = await input({ approval: 'user' });
    const run = createBenchmarkRunJob(handle, {
      ...base,
      payload: { ...base.payload, baselineArtifactVersionId: base.payload.artifactVersionId },
    });
    await expect(run).rejects.toBeInstanceOf(InvalidBaselineError);
    expect(await count(schema.jobs)).toBe(0);
    expect(await count(schema.benchmarkSuiteVersions)).toBe(0);
    expect(await count(schema.fixtureVersions)).toBe(0);
    expect(await suiteVersionApproval(handle.db, 'pdf-benchmark', 'content-1')).toBeNull();
    expect(await getJob(handle.db, 'missing')).toBeNull();
  });
});
