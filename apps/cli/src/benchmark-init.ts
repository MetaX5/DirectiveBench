import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataDirLayout, resolveDataDir } from '@directivebench/core';
import {
  ArtifactRefError,
  openDatabase,
  resolveArtifactRef,
  type ResolvedArtifactRef,
} from '@directivebench/database';
import { CliError, ExitCode } from './runtime';

/** Longest folder name before `-benchmark` (FR-118-20), so the suite id stays a valid slug. */
export const SUITE_NAME_MAX_LENGTH = 70;

/**
 * The artifact slug normalised to the suite-id pattern (SPEC-118 FR-118-20, FR-108-06): lowercase
 * `[a-z0-9-]`, no leading, trailing or repeated hyphens, at most {@link SUITE_NAME_MAX_LENGTH}
 * characters; an empty result becomes `artifact`. The result is one path segment by construction.
 */
export function suiteName(slug: string): string {
  const name = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SUITE_NAME_MAX_LENGTH)
    .replace(/-+$/, '');
  return name === '' ? 'artifact' : name;
}

/** The commented `benchmark.yaml` a new suite starts from (FR-118-21). */
export function scaffoldDefinition(
  name: string,
  artifact: ResolvedArtifactRef['artifact'],
): string {
  return `# Benchmark suite for the artifact ${artifact.slug}, created by \`directivebench benchmark init\`.
# Run it:  directivebench benchmark run ${name}-benchmark --artifact ${artifact.slug}
# Format reference: SPEC-108 (benchmark definition format) and SPEC-118 §8.4.
schemaVersion: 1
# Suite id: lowercase letters, digits and hyphens. Changing the file creates a new suite version.
id: ${name}-benchmark
name: ${JSON.stringify(`${artifact.name} benchmark`)}
# Artifact types this suite evaluates: skill, instruction or rule.
artifactTypes: [${artifact.type}]
execution:
  # The agent that runs every case: your installed Claude Code CLI.
  agent: claude-code
  # null = the CLI's default model (reported as unpinned). Pin one with:
  #   model: { provider: anthropic, model: <model name> }
  model: null
  # Each case runs this many times per variant (baseline and candidate).
  repetitions: 3
  timeoutSeconds: 300
cases:
  - id: example
    name: Example case
    # The task given to the agent, identical for the baseline and the candidate.
    prompt: |
      Read the brief in README.md and write your answer to output.md.
    # Files copied into a fresh workspace before every agent run (no Claude Code configuration).
    fixture:
      path: fixtures/example
    assertions:
      # Edit or replace. Other types: required-phrases, markdown-table-value, file-exists,
      # file-contains, changed-files and command (command runs only with --approve-commands).
      - id: has-sections
        type: markdown-sections
        file: output.md
        headings: [Summary]
`;
}

const FIXTURE_README = `# Example fixture

Replace this file with the real input of your case (a brief, a transcript, source files…).
Everything in this folder is copied into the agent's workspace before each run.
Claude Code configuration (\`.claude/\`, \`.mcp.json\`, …) is not allowed here.
`;

/** Throws unless `target` does not exist or is an empty directory (not a link). */
async function assertFreeTarget(target: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || (await readdir(target)).length > 0) {
    throw new CliError(
      `${target} already exists and is not an empty directory; remove it or run benchmark init elsewhere.`,
      ExitCode.Usage,
    );
  }
}

/** A reference error as a usage error naming the closest matches. */
export function artifactRefCliError(error: unknown): unknown {
  if (!(error instanceof ArtifactRefError)) return error;
  const hint =
    error.candidates.length === 0
      ? ''
      : ` ${error.code === 'artifact-not-found' ? 'Closest matches' : 'Available versions'}: ${error.candidates.join(', ')}.`;
  return new CliError(`${error.message}${hint}`, ExitCode.Usage);
}

/**
 * `directivebench benchmark init --artifact <ref>` (SPEC-118 FR-118-20/21): scaffolds
 * `./<name>-benchmark/` with `benchmark.yaml` and `fixtures/example/README.md`, bound to the
 * artifact, confined to the current directory. Reads the database read-only; writes nothing to it.
 */
export async function benchmarkInitCommand(flags: {
  dataDir?: string;
  artifact: string;
  cwd?: string;
}): Promise<number> {
  const layout = dataDirLayout(resolveDataDir({ flag: flags.dataDir }));
  if (!existsSync(layout.database)) {
    throw new CliError(
      `No database at ${layout.database}: start DirectiveBench and scan a repository first.`,
      ExitCode.Usage,
    );
  }
  const handle = openDatabase(layout.database, { readOnly: true });
  let resolved: ResolvedArtifactRef;
  try {
    resolved = await resolveArtifactRef(handle.db, flags.artifact);
  } catch (error) {
    throw artifactRefCliError(error);
  } finally {
    handle.close();
  }
  const cwd = resolve(flags.cwd ?? process.cwd());
  const name = suiteName(resolved.artifact.slug);
  // `name` is one plain segment by construction, so the folder is a direct child of `cwd`.
  const target = join(cwd, `${name}-benchmark`);
  await assertFreeTarget(target);
  await mkdir(join(target, 'fixtures', 'example'), { recursive: true });
  await writeFile(join(target, 'benchmark.yaml'), scaffoldDefinition(name, resolved.artifact), {
    flag: 'wx',
  });
  await writeFile(join(target, 'fixtures', 'example', 'README.md'), FIXTURE_README, {
    flag: 'wx',
  });
  console.log(`Created ${target}`);
  console.log('  benchmark.yaml              suite definition (edit the prompt and assertions)');
  console.log('  fixtures/example/README.md  the case input');
  console.log(
    `Next: directivebench benchmark run ${name}-benchmark --artifact ${resolved.artifact.slug}`,
  );
  return ExitCode.Ok;
}
