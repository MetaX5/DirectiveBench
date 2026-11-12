import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLAUDE_API_KEY_VARIABLE,
  CLAUDE_AUTH_STATUS_ARGS,
  CLAUDE_CODE_ADAPTER_ID,
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_EXECUTABLE,
  CLI_AGENTS,
  createExecutableAdapters,
  detectCliAgent,
  readVersionLine,
  type AgentModeReadiness,
  type ClaudeReadinessCode,
} from '@directivebench/agent-adapters';
import { MIN_KNOWN_SECRET_LENGTH, dataDirLayout, resolveDataDir } from '@directivebench/core';
import { enqueueBenchmarkJob, getBenchmarkRunDetail, openDatabase } from '@directivebench/database';
import {
  CA_BUNDLE_VARIABLE,
  LocalRunner,
  MIN_HOSTED_GIT_VERSION,
  buildGitEnv,
  findGitExecutable,
  importBundledExample,
  resolveCaBundle,
} from '@directivebench/runner';
import { createFileRunnerLogger } from './logger';
import { checkPortFree } from './serve';
import { CliError, ExitCode, checkNodeVersion, checkSqlite, resolveAssets } from './runtime';
import { initialize, migrationStatus, readConfig, resolveServerOptions } from './setup';

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
  /** Remediation hint; present for every check that is not `ok`. */
  hint?: string;
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The directory `init` would create the data directory in. */
function nearestExistingDir(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

/**
 * The git hosted repositories would run, and whether they would accept it (NFR-104-03): the same
 * lookup (`findGitExecutable`) and version rule (`MIN_HOSTED_GIT_VERSION`) as the hosted steps.
 */
async function gitCheck(env: NodeJS.ProcessEnv): Promise<Check> {
  const { major, minor } = MIN_HOSTED_GIT_VERSION;
  const required = `${major}.${minor}`;
  const git = await findGitExecutable(env);
  if (!git) {
    return {
      name: 'git',
      status: 'warn',
      detail: 'git not found on PATH; hosted repositories: no',
      hint: `Install git ${required} or newer to register repositories.`,
    };
  }
  const version = await readVersionLine(git, ['version'], buildGitEnv(env));
  const match = version ? /^git version (\d+)\.(\d+)/.exec(version) : null;
  const supported =
    match !== null &&
    (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
  if (supported) {
    return { name: 'git', status: 'ok', detail: `${version} (${git}); hosted repositories: yes` };
  }
  return {
    name: 'git',
    status: 'warn',
    detail: `${version ?? 'version unknown'} (${git}); hosted repositories: no (git ${required} or newer required)`,
    hint: `Update git to ${required} or newer to register GitHub repositories; local repositories are not affected.`,
  };
}

/**
 * The CA bundle check every hosted git step applies (`resolveCaBundle`, issue #60). Names the
 * variable only, never its path or the file's contents.
 */
async function caBundleCheck(env: NodeJS.ProcessEnv): Promise<Check> {
  const name = 'git:ca-bundle';
  const result = await resolveCaBundle(env);
  if (!result.ok) {
    return {
      name,
      status: 'warn',
      detail: `hosted repositories: no. ${result.message}`,
      hint: `Every hosted git step is refused while ${CA_BUNDLE_VARIABLE} is invalid; unset it to use git's default CA bundle.`,
    };
  }
  return {
    name,
    status: 'ok',
    detail:
      result.caBundle === null
        ? `${CA_BUNDLE_VARIABLE} not set (git's default CA bundle)`
        : `${CA_BUNDLE_VARIABLE} is set and resolves to a readable regular file`,
  };
}

/** The exact login probe of readiness, so a user reproduces what `doctor` saw. */
const CLAUDE_AUTH_STATUS_COMMAND = [CLAUDE_EXECUTABLE, ...CLAUDE_AUTH_STATUS_ARGS].join(' ');

const USE_API_KEY_MODE = `set ${CLAUDE_API_KEY_VARIABLE} to use API key mode`;

/**
 * Remediation hint per SPEC-203 §9 readiness code (SPEC-009 §4: every non-`ok` check has one).
 * `auth-missing` also covers a login probe that timed out, failed or gave unreadable output, and
 * an API key that is set but unusable, so its hints cover those cases too. Hints name the
 * variable to set, never its value.
 */
const CLAUDE_READINESS_HINTS: Record<ClaudeReadinessCode, (mode: string) => string> = {
  'binary-not-found': () =>
    `Install Claude Code and make sure \`${CLAUDE_EXECUTABLE}\` is on PATH.`,
  'version-unsupported': () =>
    `Check \`claude --version\`: if it shows a version older than ${CLAUDE_CODE_MIN_VERSION}, update Claude Code; otherwise fix the cause named in the warning (for example a \`claude\` that fails or cannot be started). Then run \`directivebench doctor\` again.`,
  'auth-missing': (mode) =>
    mode === 'api-key'
      ? `Set ${CLAUDE_API_KEY_VARIABLE} to your full API key (at least ${MIN_KNOWN_SECRET_LENGTH} characters, on one line) in the environment that runs DirectiveBench to use API key mode, or run \`claude\` and \`/login\` to use subscription mode.`
      : `Run \`${CLAUDE_AUTH_STATUS_COMMAND}\` in an empty directory (the probe doctor runs): if it shows no Claude subscription login, run \`claude\` and \`/login\`; otherwise fix the cause named in the warning (for example a \`claude\` that fails, hangs or cannot be started) and run \`directivebench doctor\` again. Or ${USE_API_KEY_MODE}.`,
  'auth-expired': () =>
    `Run \`claude\` and \`/login\` to renew the expired login, or ${USE_API_KEY_MODE}.`,
  'auth-mismatch': () =>
    `Run \`claude\` and \`/login\` with a Claude subscription account (not an API key or key helper), or ${USE_API_KEY_MODE}.`,
};

/** Hint for an auth mode that is not ready; a generic one for a code no table covers. */
export function agentReadinessHint(agentId: string, { mode, code }: AgentModeReadiness): string {
  if (
    agentId !== CLAUDE_CODE_ADAPTER_ID ||
    code === null ||
    !Object.hasOwn(CLAUDE_READINESS_HINTS, code)
  ) {
    return 'Fix the problem described above, then run `directivebench doctor` again.';
  }
  return CLAUDE_READINESS_HINTS[code as ClaudeReadinessCode](mode);
}

/** Read-only diagnostics; never creates or migrates anything. */
export async function doctorCommand(flags: { dataDir?: string; json?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, hint?: string) =>
    checks.push({ name, status, detail, ...(status === 'ok' ? {} : { hint }) });

  const node = checkNodeVersion();
  add(
    'node',
    node.ok ? 'ok' : 'fail',
    node.message,
    'Install Node.js 22.16 or newer (Node 24 LTS recommended).',
  );
  const sqlite = await checkSqlite();
  add(
    'sqlite',
    sqlite.ok ? 'ok' : 'fail',
    sqlite.message,
    'Use an official Node.js build >= 22.16; node:sqlite is built in.',
  );

  const layout = dataDirLayout(resolveDataDir({ flag: flags.dataDir }));
  if (existsSync(layout.root)) {
    const writable = isWritable(layout.root);
    add(
      'data-dir',
      writable ? 'ok' : 'fail',
      `${layout.root}${writable ? '' : ' is not writable'}`,
      'Fix the directory permissions or choose another location with --data-dir / DIRECTIVEBENCH_DATA_DIR.',
    );
  } else {
    const parent = nearestExistingDir(layout.root);
    const writable = isWritable(parent);
    add(
      'data-dir',
      writable ? 'warn' : 'fail',
      writable
        ? `${layout.root} does not exist yet`
        : `${layout.root} cannot be created: ${parent} is not writable`,
      writable
        ? 'Run `directivebench init` (or just start `directivebench`) to create it.'
        : 'Choose a writable location with --data-dir / DIRECTIVEBENCH_DATA_DIR.',
    );
  }

  let config;
  try {
    config = readConfig(layout);
    add(
      'config',
      'ok',
      existsSync(layout.config) ? layout.config : 'defaults (no config.json yet)',
    );
  } catch (error) {
    add(
      'config',
      'fail',
      (error as Error).message,
      `Fix or delete ${layout.config}; defaults are used when it is absent.`,
    );
  }

  try {
    const assets = resolveAssets();
    add(
      'web-build',
      assets.mode === 'packaged' || existsSync(`${assets.webDir}/.next/BUILD_ID`) ? 'ok' : 'warn',
      `${assets.mode}: ${assets.webDir}`,
      'Run `pnpm build` in the repository (source checkouts only), or use `serve --dev`.',
    );
    if (existsSync(layout.database)) {
      const handle = openDatabase(layout.database, { readOnly: true });
      try {
        const { applied, expected } = migrationStatus(handle, assets.migrationsDir);
        add(
          'database',
          applied === expected ? 'ok' : 'warn',
          `${applied}/${expected} migrations applied`,
          'Run `directivebench init` to apply pending migrations.',
        );
      } finally {
        handle.close();
      }
    } else {
      add('database', 'warn', 'not created yet', 'Run `directivebench init` to create it.');
    }
  } catch (error) {
    add(
      'installation',
      'fail',
      (error as Error).message,
      'Reinstall DirectiveBench (`npx directivebench@latest`).',
    );
  }

  if (config) {
    try {
      const { host, port } = resolveServerOptions({}, config);
      const free = await checkPortFree(host, port);
      add(
        'port',
        free ? 'ok' : 'warn',
        `${host}:${port} ${free ? 'is free' : 'is in use (another instance running?)'}`,
        'Stop the other process or start with --port <port>.',
      );
    } catch (error) {
      add(
        'port',
        'fail',
        (error as Error).message,
        'Fix server.host / server.port in config.json or the DIRECTIVEBENCH_HOST / DIRECTIVEBENCH_PORT variables.',
      );
    }
  }

  checks.push(await gitCheck(process.env), await caBundleCheck(process.env));

  for (const descriptor of CLI_AGENTS) {
    const detection = await detectCliAgent(descriptor);
    add(
      `agent:${descriptor.id}`,
      'ok',
      detection.installed
        ? `${descriptor.displayName} found (${detection.version ?? 'version unknown'}); ${descriptor.id === CLAUDE_CODE_ADAPTER_ID ? 'runs benchmarks with `directivebench benchmark run`' : 'benchmark execution not implemented yet'}`
        : `${descriptor.displayName} not found on PATH (optional)`,
    );
    if (!detection.installed) continue;
    // Readiness per auth mode (SPEC-118 FR-118-35). One ready mode is enough, so a mode that is
    // not ready only warns when no mode is.
    for (const mode of detection.readiness ?? []) {
      add(
        `agent:${descriptor.id}:${mode.mode}`,
        mode.ready || detection.auth === 'ready' ? 'ok' : 'warn',
        mode.ready ? `ready: ${mode.detail}` : `not ready (${mode.code}): ${mode.detail}`,
        agentReadinessHint(descriptor.id, mode),
      );
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}`);
      if (check.hint) console.log(`      → ${check.hint}`);
    }
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
    const runner: LocalRunner = new LocalRunner({
      handle,
      fixtureStore: layout.fixtures,
      cacheDir: layout.cache,
      adapters: createExecutableAdapters(),
      keepWorkspaces: config.runner.keepWorkspaces,
      logger: createFileRunnerLogger(
        join(layout.logs, 'runner.log'),
        (): string => runner.runnerId,
      ),
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
