import { Command, CommanderError } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { benchmarkInitCommand } from './benchmark-init';
import type { BenchmarkRunFlags } from './benchmark-plan';
import { benchmarkRunCommand } from './benchmark-run';
import { demoCommand, doctorCommand, initCommand } from './commands';
import { CliError, ExitCode, assertSupportedRuntime } from './runtime';
import { serve, type ServeFlags } from './serve';

function addServeOptions(command: Command): Command {
  return command
    .option('--host <host>', 'host to bind (default 127.0.0.1; env DIRECTIVEBENCH_HOST)')
    .option('--port <port>', 'port to listen on (default 4280; env DIRECTIVEBENCH_PORT)')
    .option('--no-open', 'do not open a browser')
    .option('--allow-network-access', 'allow binding to a non-loopback host (no authentication!)');
}

function run(action: () => Promise<number>): () => Promise<void> {
  return async () => {
    assertSupportedRuntime();
    process.exitCode = await action();
  };
}

const program = new Command()
  .name('directivebench')
  .description('Local-first workbench for AI agent skills, instructions and rules.')
  .version(packageJson.version, '-V, --version')
  .option('--data-dir <path>', 'data directory (env DIRECTIVEBENCH_DATA_DIR)')
  .showHelpAfterError()
  .exitOverride();

const globalDataDir = () => program.opts<{ dataDir?: string }>().dataDir;

/** Serve options may be given before or after the `serve` subcommand. */
function serveFlags(local: ServeFlags = {}): ServeFlags {
  const global = program.opts<ServeFlags>();
  return {
    host: local.host ?? global.host,
    port: local.port ?? global.port,
    open: local.open !== false && global.open !== false,
    allowNetworkAccess: Boolean(local.allowNetworkAccess ?? global.allowNetworkAccess),
    dev: Boolean(local.dev),
    dataDir: globalDataDir(),
  };
}

addServeOptions(program).action(run(() => serve(serveFlags())));

addServeOptions(program.command('serve').description('start the local web UI and job runner'))
  .option('--dev', 'run Next.js in development mode (source checkout only)')
  .action((options: ServeFlags) => run(() => serve(serveFlags(options)))());

program
  .command('init')
  .description('create the data directory, configuration and database')
  .action(() => run(() => initCommand({ dataDir: globalDataDir() }))());

program
  .command('doctor')
  .description('diagnose the local environment (read-only)')
  .option('--json', 'machine-readable output')
  .action((options: { json?: boolean }) =>
    run(() => doctorCommand({ ...options, dataDir: globalDataDir() }))(),
  );

program
  .command('demo')
  .description('import the bundled example and run it with the deterministic mock agent')
  .action(() => run(() => demoCommand({ dataDir: globalDataDir() }))());

const benchmark = program
  .command('benchmark')
  .description('benchmark your own skills with Claude Code (SPEC-118)');

benchmark
  .command('init')
  .description('scaffold a benchmark suite folder for a scanned artifact')
  .requiredOption('--artifact <ref>', 'artifact id or slug')
  .action((options: { artifact: string }) =>
    run(() => benchmarkInitCommand({ artifact: options.artifact, dataDir: globalDataDir() }))(),
  );

benchmark
  .command('run')
  .description('run a suite against an artifact version with Claude Code and print the verdict')
  .argument('<suite>', 'suite folder (with benchmark.yaml) or definition file')
  .requiredOption('--artifact <ref>', 'artifact id or slug')
  // Not `--version`: the program's own -V/--version would take it (SPEC-118 FR-118-30).
  .option('--artifact-version <n>', 'artifact version number (default: latest)')
  .option('--baseline <none|vN>', 'compare with no artifact (default) or another version')
  .option('--auth <mode>', 'subscription (default) or api-key (ANTHROPIC_API_KEY)')
  .option('--max-budget-usd <n>', 'budget cap per agent run, API Key Mode only')
  .option('--approve-commands', 'approve the setup and command argv this suite version runs')
  .option('--yes', 'start without asking for confirmation')
  .option('--json', 'print the result as one JSON object')
  .action(
    (
      suite: string,
      {
        artifactVersion,
        ...options
      }: Omit<BenchmarkRunFlags, 'suite' | 'dataDir' | 'version'> & {
        artifactVersion?: string;
      },
    ) =>
      run(() =>
        benchmarkRunCommand({
          ...options,
          ...(artifactVersion === undefined ? {} : { version: artifactVersion }),
          suite,
          dataDir: globalDataDir(),
        }),
      )(),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
  } else if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = ExitCode.Runtime;
  }
}
