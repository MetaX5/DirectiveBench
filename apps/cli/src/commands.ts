import { existsSync } from 'node:fs';
import {
  CLI_AGENTS,
  createExecutableAdapters,
  detectCliAgent,
} from '@directivebench/agent-adapters';
import { dataDirLayout, resolveDataDir } from '@directivebench/core';
import { enqueueBenchmarkJob, getBenchmarkRunDetail, openDatabase } from '@directivebench/database';
import { LocalRunner, importBundledExample } from '@directivebench/runner';
import { checkPortFree } from './serve';
import { CliError, ExitCode, checkNodeVersion, checkSqlite, resolveAssets } from './runtime';
import { initialize, readConfig, resolveServerOptions } from './setup';

export async function initCommand(flags: { dataDir?: string }): Promise<number> {
  const assets = resolveAssets();
  const workspace = await initialize(flags.dataDir, assets.migrationsDir);
  workspace.handle.close();
  console.log(`Data directory: ${workspace.layout.root}`);
  console.log(
    `  config:     ${workspace.createdConfig ? 'created' : 'kept'} ${workspace.layout.config}`,
  );
  console.log(
    `  database:   ${workspace.layout.database} (${workspace.appliedMigrations} migration(s) applied)`,
  );
  console.log('Initialised.');
  return ExitCode.Ok;
}

type CheckStatus = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Read-only diagnostics; never creates or migrates anything. */
export async function doctorCommand(flags: { dataDir?: string; json?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  const node = checkNodeVersion();
  add('node', node.ok ? 'ok' : 'fail', node.message);
  const sqlite = await checkSqlite();
  add('sqlite', sqlite.ok ? 'ok' : 'fail', sqlite.message);

  const layout = dataDirLayout(resolveDataDir({ flag: flags.dataDir }));
  add(
    'data-dir',
    existsSync(layout.root) ? 'ok' : 'warn',
    existsSync(layout.root)
      ? layout.root
      : `${layout.root} does not exist yet (run \`directivebench init\`)`,
  );

  let config;
  try {
    config = readConfig(layout);
    add(
      'config',
      'ok',
      existsSync(layout.config) ? layout.config : 'defaults (no config.json yet)',
    );
  } catch (error) {
    add('config', 'fail', (error as Error).message);
  }

  try {
    const assets = resolveAssets();
    add(
      'web-build',
      assets.mode === 'packaged' || existsSync(`${assets.webDir}/.next/BUILD_ID`) ? 'ok' : 'warn',
      `${assets.mode}: ${assets.webDir}`,
    );
    if (existsSync(layout.database)) {
      const handle = openDatabase(layout.database, { readOnly: true });
      try {
        const { readdirSync } = await import('node:fs');
        const expected = readdirSync(assets.migrationsDir).filter((f) => f.endsWith('.sql')).length;
        const row = handle.sqlite
          .prepare(
            "select count(*) as n from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
          )
          .get() as { n: number };
        const applied = row.n
          ? (
              handle.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as {
                n: number;
              }
            ).n
          : 0;
        add(
          'database',
          applied === expected ? 'ok' : 'warn',
          `${applied}/${expected} migrations applied${applied === expected ? '' : ' (run `directivebench init`)'}`,
        );
      } finally {
        handle.close();
      }
    } else {
      add('database', 'warn', 'not created yet (run `directivebench init`)');
    }
  } catch (error) {
    add('installation', 'fail', (error as Error).message);
  }

  if (config) {
    try {
      const { host, port } = resolveServerOptions({}, config);
      const free = await checkPortFree(host, port);
      add(
        'port',
        free ? 'ok' : 'warn',
        `${host}:${port} ${free ? 'is free' : 'is in use (another instance running?)'}`,
      );
    } catch (error) {
      add('port', 'fail', (error as Error).message);
    }
  }

  for (const descriptor of CLI_AGENTS) {
    const detection = await detectCliAgent(descriptor);
    add(
      `agent:${descriptor.id}`,
      'ok',
      detection.installed
        ? `${descriptor.displayName} found (${detection.version ?? 'version unknown'}); benchmark execution not implemented yet`
        : `${descriptor.displayName} not found on PATH (optional)`,
    );
  }

  if (flags.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    for (const check of checks)
      console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  return checks.some((c) => c.status === 'fail') ? ExitCode.CheckFailed : ExitCode.Ok;
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** Imports the bundled example and runs it headless with the deterministic mock agent. */
export async function demoCommand(flags: { dataDir?: string }): Promise<number> {
  const assets = resolveAssets();
  const { layout, config, handle } = await initialize(flags.dataDir, assets.migrationsDir);
  try {
    const example = await importBundledExample(handle, assets.examplesDir, layout.fixtures);
    console.log(
      `Artifact:  ${example.artifact.name} v${example.artifact.version}${example.artifact.createdVersion ? ' (imported)' : ''}`,
    );
    console.log(
      `Benchmark: ${example.suite.name} v${example.suite.version}${example.suite.createdVersion ? ' (imported)' : ''}`,
    );
    await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    console.log('Running RED (baseline) and GREEN (candidate) variants with the Mock Agent…');
    const runner = new LocalRunner({
      handle,
      fixtureStore: layout.fixtures,
      adapters: createExecutableAdapters(),
      keepWorkspaces: config.runner.keepWorkspaces,
    });
    const results = await runner.runUntilIdle();
    const result = results.at(-1);
    if (!result?.benchmarkRunId || result.status !== 'completed') {
      throw new CliError(
        `Demo benchmark did not complete: ${result?.error ?? 'no job executed'}`,
        ExitCode.CheckFailed,
      );
    }
    const detail = await getBenchmarkRunDetail(handle.db, result.benchmarkRunId);
    const summary = detail?.run.summary as
      | {
          baseline: { meanScore: number; passRate: number };
          candidate: { meanScore: number; passRate: number };
          delta: number;
          verdict: string;
          confidence: { level: string };
        }
      | undefined;
    if (!summary) throw new CliError('Demo run has no summary', ExitCode.CheckFailed);
    console.log('');
    console.log(
      'Mock agent — not an AI evaluation. Scores come from real assertions on generated files.',
    );
    console.log(
      `  Baseline (RED):    score ${pct(summary.baseline.meanScore)}, pass rate ${pct(summary.baseline.passRate)}`,
    );
    console.log(
      `  Candidate (GREEN): score ${pct(summary.candidate.meanScore)}, pass rate ${pct(summary.candidate.passRate)}`,
    );
    console.log(
      `  Delta:             ${summary.delta > 0 ? '+' : ''}${(summary.delta * 100).toFixed(1)} points`,
    );
    console.log(
      `  Verdict:           ${summary.verdict} (confidence: ${summary.confidence.level})`,
    );
    console.log(`  Run id:            ${result.benchmarkRunId}`);
    console.log('\nStart the UI with `directivebench` to inspect assertions and traces.');
    return summary.verdict === 'improved' ? ExitCode.Ok : ExitCode.CheckFailed;
  } finally {
    handle.close();
  }
}
