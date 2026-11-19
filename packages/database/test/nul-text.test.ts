import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  acquireNextJob,
  enqueueBenchmarkJob,
  finishBenchmarkRun,
  finishJob,
  getBenchmarkRunDetail,
  getJob,
  getRepository,
  insertAgentRun,
  interruptJobs,
  markRepositoryScanFailed,
  NulInTextError,
  storedMessage,
} from '../src/index';
import { registerLocal, seedRun, seedTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// Issue 265: node:sqlite on Node 22 returns a TEXT value only up to its first U+0000, so text
// holding one is never stored. These tests run in the oldest-node CI job.

const getHandle = useTestDatabase();

describe('the database refuses text holding U+0000 (issue 265)', () => {
  it('throws NulInTextError for a string parameter with a NUL and stores nothing', async () => {
    const handle = getHandle();
    await handle.db.run(sql`create table probe (value text)`);

    // Drizzle wraps a driver error in its own query error, with the driver error as the cause.
    const error = await handle.db
      .run(sql`insert into probe values (${'nul\0.txt'})`)
      .catch((caught: unknown) => caught);
    expect((error as Error).cause).toBeInstanceOf(NulInTextError);
    expect(await handle.db.all(sql`select value from probe`)).toEqual([]);
  });

  it('names the parameter by position and never puts its value in its own message', async () => {
    const handle = getHandle();
    const error = await handle.db
      .all(sql`select ${'ok'} as a, ${'secret\0value'} as b`)
      .catch((caught: unknown) => caught);
    const cause = (error as Error).cause as NulInTextError;
    expect(cause).toBeInstanceOf(NulInTextError);
    expect(cause.name).toBe('NulInTextError');
    expect(cause.parameterIndex).toBe(2);
    expect(cause.message).toBe(
      'Parameter 2 of a database statement contains a NUL character (U+0000); text holding NUL ' +
        'is not stored because node:sqlite on Node 22 truncates it on read',
    );
  });

  it('stores and reads text, numbers, null and JSON-escaped NUL unchanged', async () => {
    const handle = getHandle();
    const json = JSON.stringify({ out: 'a\0b' });
    const rows = await handle.db.all<[string, number, null, string]>(
      sql`select ${'plain'}, ${7}, ${null}, ${json}`,
    );
    expect(rows).toEqual([['plain', 7, null, json]]);
    expect(JSON.parse(rows[0]![3]) as unknown).toEqual({ out: 'a\0b' });
  });
});

describe('storedMessage (issue 265)', () => {
  it('replaces each NUL with U+FFFD and keeps other text and null unchanged', () => {
    expect(storedMessage('a\0b\0')).toBe('a�b�');
    expect(storedMessage('no nul here')).toBe('no nul here');
    expect(storedMessage(null)).toBeNull();
  });
});

describe('error and message columns replace NUL with U+FFFD (issue 265)', () => {
  it('stores agent run errors, output file reasons and assertion messages', async () => {
    const handle = getHandle();
    const runId = await seedRun(handle, await seedTargets(handle));
    await insertAgentRun(handle, {
      benchmarkRunId: runId,
      caseId: 'case-a',
      variant: 'baseline',
      repetition: 1,
      fixtureVersionId: 'sha-1',
      executionStatus: 'agent-error',
      score: null,
      passed: null,
      durationMs: 1,
      changedFiles: [],
      trace: [],
      usage: null,
      error: 'agent said a\0b',
      assertions: [
        {
          assertionId: 'output',
          type: 'contains',
          passed: false,
          score: 0,
          weight: 1,
          required: true,
          deterministic: true,
          message: 'expected x\0y',
          details: null,
        },
      ],
      outputFilesKept: false,
      outputFilesReason: 'reason\0',
      outputFiles: [],
    });

    const [run] = (await getBenchmarkRunDetail(handle.db, runId))!.agentRuns;
    expect(run).toMatchObject({ error: 'agent said a�b', outputFilesReason: 'reason�' });
    expect(run!.assertions[0]!.message).toBe('expected x�y');
  });

  it('stores benchmark run, job and repository scan errors', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const payload = {
      suiteVersionId: targets.suiteVersionId,
      artifactVersionId: targets.artifactVersionId,
    };
    const finished = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    await finishJob(handle.db, finished.id, 'failed', 'job \0 failed');
    expect((await getJob(handle.db, finished.id))?.error).toBe('job � failed');

    const interrupted = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    const runId = await seedRun(handle, targets, { jobId: interrupted.id });
    expect(await interruptJobs(handle.db, [interrupted.id], 'stop\0')).toEqual([interrupted.id]);
    expect((await getJob(handle.db, interrupted.id))?.error).toBe('stop�');
    expect((await getBenchmarkRunDetail(handle.db, runId))?.run.error).toBe('stop�');

    const other = await seedRun(handle, targets);
    await finishBenchmarkRun(handle.db, other, {
      status: 'error',
      verdict: null,
      summary: null,
      comparabilityKey: null,
      warnings: [],
      error: 'run \0 failed',
    });
    expect((await getBenchmarkRunDetail(handle.db, other))?.run.error).toBe('run � failed');

    const { repository } = await registerLocal(handle, { location: '/srv/nul' });
    await markRepositoryScanFailed(handle.db, repository.id, 'scan \0 failed');
    expect((await getRepository(handle.db, repository.id))?.syncError).toBe('scan � failed');
  });
});
