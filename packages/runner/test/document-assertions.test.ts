import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExecutableAdapters } from '@directivebench/agent-adapters';
import {
  enqueueBenchmarkJob,
  getBenchmarkRunDetail,
  migrateDatabase,
  openDatabase,
  seedPredefinedCategories,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner, importBenchmarkSuite, importBundledExample } from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const examples = fileURLToPath(new URL('../../../examples', import.meta.url));

let handle: DatabaseHandle;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-runner-docs-'));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  await seedPredefinedCategories(handle.db);
});

afterEach(() => handle.close());

/** A mock suite whose agent writes a Markdown estimate; `pattern` is a required phrase. */
function writeSuite(pattern: string): string {
  const root = mkdtempSync(join(tmpdir(), 'directivebench-doc-suite-'));
  mkdirSync(join(root, 'fixture'));
  writeFileSync(join(root, 'fixture/brief.md'), 'Estimate the widget.\n');
  const estimate = `# Assumptions\n\n# Estimate\n\n| Item | Hours |\n| - | - |\n| Backend API | 24 |\n\n# Risks\n\n${'a'.repeat(32)}!\n`;
  const definition = {
    schemaVersion: 1,
    id: 'doc-suite',
    name: 'Document suite',
    artifactTypes: ['skill'],
    execution: { agent: 'mock', repetitions: 1 },
    cases: [
      {
        id: 'estimate',
        name: 'Estimate',
        prompt: 'Write an estimate.',
        fixture: { path: 'fixture' },
        agentOptions: {
          mock: {
            playbook: [
              {
                id: 'write',
                description: 'Write the estimate',
                write: { path: 'estimate.md', content: estimate },
              },
            ],
          },
        },
        assertions: [
          {
            id: 'structure',
            type: 'markdown-sections',
            file: '*.md',
            headings: ['Assumptions', 'Estimate', 'Risks'],
            ordered: true,
          },
          {
            id: 'hours',
            type: 'markdown-table-value',
            file: '*.md',
            row: { pattern: 'backend', flags: 'i' },
            column: 'Hours',
            min: 16,
            max: 40,
          },
          {
            id: 'phrases',
            type: 'required-phrases',
            file: '*.md',
            phrases: ['Backend API', { pattern }],
          },
        ],
      },
    ],
  };
  writeFileSync(join(root, 'benchmark.json'), JSON.stringify(definition));
  return join(root, 'benchmark.json');
}

async function run(pattern: string) {
  const fixtures = join(dataDir, 'fixtures');
  const example = await importBundledExample(handle, examples, fixtures);
  const suite = await importBenchmarkSuite(handle, writeSuite(pattern), fixtures, null);
  await enqueueBenchmarkJob(handle.db, {
    suiteVersionId: suite.versionId,
    artifactVersionId: example.artifact.versionId,
  });
  const runner = new LocalRunner({
    handle,
    fixtureStore: fixtures,
    cacheDir: join(dataDir, 'cache'),
    adapters: createExecutableAdapters(),
    workspaceRoot: join(dataDir, 'workspaces'),
  });
  const [result] = await runner.runUntilIdle();
  return getBenchmarkRunDetail(handle.db, result?.benchmarkRunId as string);
}

describe('document assertions through the runner (SPEC-118 §6.5, §8.1)', () => {
  it('persists passing document assertions with their details', async () => {
    const detail = await run('PM\\b|Backend');
    expect(detail?.agentRuns.map((r) => [r.variant, r.executionStatus, r.score])).toEqual([
      ['baseline', 'completed', 1],
      ['candidate', 'completed', 1],
    ]);
    const hours = detail?.agentRuns[0]?.assertions.find((a) => a.assertionId === 'hours');
    expect(hours).toMatchObject({
      passed: true,
      details: { file: 'estimate.md', tableIndex: 1, cell: '24', value: 24 },
    });
  }, 30_000);

  it('stores an unfinished pattern as an assertion error and the agent run as an infrastructure error', async () => {
    const detail = await run('(a+)+$');
    expect(detail?.run.verdict).toBe('error');
    for (const agentRun of detail?.agentRuns ?? []) {
      expect(agentRun).toMatchObject({
        executionStatus: 'infrastructure-error',
        score: null,
        error:
          'assertion-error: assertion "phrases" could not be evaluated: Pattern evaluation exceeded 2000 ms; simplify the regular expression',
      });
      expect(agentRun.assertions.map((a) => [a.assertionId, a.passed, a.score])).toEqual([
        ['structure', true, 1],
        ['hours', true, 1],
        ['phrases', false, 0],
      ]);
      expect(agentRun.assertions[2]?.details).toEqual({
        error: {
          code: 'pattern-timeout',
          message: 'Pattern evaluation exceeded 2000 ms; simplify the regular expression',
        },
        patterns: ['/(a+)+$/'],
      });
    }
  }, 30_000);
});
